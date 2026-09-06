import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ── SDK discovery ───────────────────────────────────────────────────────────
// MCP servers are often launched without the user's shell PATH, so resolve the
// SDK tools from the usual env vars / default install location.

const SDK_ROOT =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(homedir(), "Library", "Android", "sdk");

function sdkTool(relative: string, fallback: string): string {
  const full = join(SDK_ROOT, relative);
  return existsSync(full) ? full : fallback;
}

const ADB = sdkTool("platform-tools/adb", "adb");
const EMULATOR = sdkTool("emulator/emulator", "emulator");

// ── helpers ─────────────────────────────────────────────────────────────────

async function run(bin: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout || stderr;
}

async function runBinary(bin: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function listSerials(): Promise<string[]> {
  const out = await run(ADB, ["devices"]);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith("\tdevice"))
    .map((l) => l.split("\t")[0]);
}

/** Resolve the device serial: use the given one, else the single connected device. */
async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const serials = await listSerials();
  if (serials.length === 0) throw new Error("No Android device/emulator is connected. Boot one with boot_emulator.");
  if (serials.length > 1) throw new Error(`Multiple devices connected (${serials.join(", ")}). Pass a serial.`);
  return serials[0];
}

async function adb(serial: string, args: string[]): Promise<string> {
  return run(ADB, ["-s", serial, ...args]);
}

async function shell(serial: string, args: string[]): Promise<string> {
  return adb(serial, ["shell", ...args]);
}

/** Quote a string for the device's /bin/sh (adb shell concatenates args into one command line). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Read width/height from a PNG header. */
function pngSize(png: Buffer): { w: number; h: number } | null {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") return null;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const serialParam = z
  .string()
  .optional()
  .describe("Device serial (e.g. emulator-5554). Optional when exactly one device is connected.");

const BUTTONS = {
  HOME: "KEYCODE_HOME",
  BACK: "KEYCODE_BACK",
  MENU: "KEYCODE_MENU",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  POWER: "KEYCODE_POWER",
  VOLUME_UP: "KEYCODE_VOLUME_UP",
  VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
  ENTER: "KEYCODE_ENTER",
  DEL: "KEYCODE_DEL",
  TAB: "KEYCODE_TAB",
  CAMERA: "KEYCODE_CAMERA",
  SEARCH: "KEYCODE_SEARCH",
} as const;

// ── uiautomator XML → compact JSON ──────────────────────────────────────────

interface UiNode {
  depth: number;
  class: string;
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  package?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  center: { x: number; y: number };
  clickable?: true;
  longClickable?: true;
  scrollable?: true;
  checkable?: true;
  checked?: true;
  focused?: true;
  selected?: true;
  enabled?: false;
  password?: true;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function parseUiDump(xml: string, includeAll: boolean): UiNode[] {
  const nodes: UiNode[] = [];
  let depth = 0;
  const tokenRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml))) {
    if (m[0] === "</node>") {
      depth--;
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = decodeXml(a[2]);

    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number);
      const node: UiNode = {
        depth,
        class: attrs.class ?? "",
        bounds: { x1, y1, x2, y2 },
        center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
      };
      if (attrs.text) node.text = attrs.text;
      if (attrs["content-desc"]) node.contentDesc = attrs["content-desc"];
      if (attrs["resource-id"]) node.resourceId = attrs["resource-id"];
      if (attrs.package) node.package = attrs.package;
      if (attrs.clickable === "true") node.clickable = true;
      if (attrs["long-clickable"] === "true") node.longClickable = true;
      if (attrs.scrollable === "true") node.scrollable = true;
      if (attrs.checkable === "true") node.checkable = true;
      if (attrs.checked === "true") node.checked = true;
      if (attrs.focused === "true") node.focused = true;
      if (attrs.selected === "true") node.selected = true;
      if (attrs.enabled === "false") node.enabled = false;
      if (attrs.password === "true") node.password = true;

      const interesting =
        node.text || node.contentDesc || node.clickable || node.scrollable || node.checkable || node.focused;
      if (includeAll || interesting) nodes.push(node);
    }
    if (m[2] !== "/") depth++;
  }
  return nodes;
}

async function uiDump(serial: string): Promise<string> {
  // uiautomator occasionally fails with "could not get idle state"; retry a few times.
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await adb(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
      const start = out.indexOf("<?xml");
      const end = out.lastIndexOf("</hierarchy>");
      if (start >= 0 && end >= 0) return out.slice(start, end + "</hierarchy>".length);
      lastErr = out;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }
  throw new Error(`uiautomator dump failed: ${lastErr}`);
}

// ── server ──────────────────────────────────────────────────────────────────

const recordings = new Map<string, { proc: ChildProcess; remotePath: string; outputPath: string }>();

const server = new McpServer({ name: "android-emulator-mcp", version: "1.0.0" });

// ── emulator / device control ───────────────────────────────────────────────

server.registerTool(
  "list_emulators",
  {
    description: "List available Android Virtual Devices (AVDs) and currently connected devices/emulators",
    inputSchema: {},
  },
  async () => {
    const avds = (await run(EMULATOR, ["-list-avds"]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("INFO"));
    const devices = await run(ADB, ["devices", "-l"]);
    const running: Record<string, string> = {};
    for (const serial of await listSerials()) {
      if (serial.startsWith("emulator-")) {
        try {
          running[serial] = (await adb(serial, ["emu", "avd", "name"])).split("\n")[0].trim();
        } catch {
          running[serial] = "unknown";
        }
      }
    }
    return text(
      JSON.stringify({ avds, running_emulators: running, adb_devices: devices.trim() }, null, 2)
    );
  }
);

server.registerTool(
  "boot_emulator",
  {
    description: "Boot an Android emulator by AVD name and wait until it has finished booting. Returns the device serial.",
    inputSchema: {
      avd: z.string().describe("AVD name from list_emulators"),
      timeout_seconds: z.number().default(180),
      wipe_data: z.boolean().default(false).describe("Start from a clean data image"),
    },
  },
  async ({ avd, timeout_seconds, wipe_data }) => {
    const before = new Set(await listSerials());
    const args = ["-avd", avd, "-no-snapshot-save"];
    if (wipe_data) args.push("-wipe-data");
    const proc = spawn(EMULATOR, args, { detached: true, stdio: "ignore" });
    proc.unref();

    const deadline = Date.now() + timeout_seconds * 1000;
    let serial: string | undefined;
    while (Date.now() < deadline) {
      const now = await listSerials();
      serial = now.find((s) => s.startsWith("emulator-") && !before.has(s));
      if (serial) {
        const booted = (await shell(serial, ["getprop", "sys.boot_completed"]).catch(() => "")).trim();
        if (booted === "1") return text(`Booted ${avd} as ${serial}`);
      }
      await sleep(2000);
    }
    return text(`Timed out after ${timeout_seconds}s waiting for ${avd} to boot${serial ? ` (serial ${serial})` : ""}`);
  }
);

server.registerTool(
  "shutdown_emulator",
  {
    description: "Shut down a running emulator",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    await adb(s, ["emu", "kill"]);
    return text(`Shutdown ${s}`);
  }
);

server.registerTool(
  "get_booted_serial",
  {
    description: "Get the serial(s) of currently connected devices/emulators",
    inputSchema: {},
  },
  async () => text(JSON.stringify(await listSerials()))
);

server.registerTool(
  "get_screen_info",
  {
    description:
      "Get the screen size (pixels) and density. Screenshots, tap coordinates and describe_ui bounds all share this same pixel coordinate space — no scaling needed.",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    const size = await shell(s, ["wm", "size"]);
    const density = await shell(s, ["wm", "density"]);
    const orientation = (await shell(s, ["settings", "get", "system", "user_rotation"])).trim();
    const sizeMatch = /(?:Override|Physical) size: (\d+)x(\d+)/.exec(size.includes("Override") ? size.split("Override")[1] : size);
    const densMatch = /(\d+)/.exec(density.split("Override").pop() ?? "");
    return text(
      `Screen size: ${sizeMatch ? `${sizeMatch[1]} x ${sizeMatch[2]}` : size.trim()} px\n` +
        `Density: ${densMatch ? densMatch[1] : density.trim()} dpi\n` +
        `Rotation: ${orientation} (0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape)\n` +
        `Tap/swipe coordinates use these pixel dimensions directly.`
    );
  }
);

// ── app management ──────────────────────────────────────────────────────────

server.registerTool(
  "install_app",
  {
    description: "Install an .apk on the device",
    inputSchema: {
      serial: serialParam,
      apk_path: z.string().describe("Absolute path to .apk file"),
    },
  },
  async ({ serial, apk_path }) => {
    const s = await resolveSerial(serial);
    const out = await adb(s, ["install", "-r", "-g", apk_path]);
    return text(out.trim() || "App installed");
  }
);

server.registerTool(
  "uninstall_app",
  {
    description: "Uninstall an app by package name",
    inputSchema: { serial: serialParam, package: z.string() },
  },
  async ({ serial, package: pkg }) => {
    const s = await resolveSerial(serial);
    const out = await adb(s, ["uninstall", pkg]);
    return text(out.trim());
  }
);

server.registerTool(
  "list_apps",
  {
    description: "List installed packages (third-party only by default)",
    inputSchema: {
      serial: serialParam,
      include_system: z.boolean().default(false),
    },
  },
  async ({ serial, include_system }) => {
    const s = await resolveSerial(serial);
    const out = await shell(s, ["pm", "list", "packages", ...(include_system ? [] : ["-3"])]);
    const pkgs = out
      .split("\n")
      .map((l) => l.trim().replace(/^package:/, ""))
      .filter(Boolean)
      .sort();
    return text(pkgs.join("\n"));
  }
);

server.registerTool(
  "launch_app",
  {
    description: "Launch an app by package name (uses its main launcher activity), or a specific activity",
    inputSchema: {
      serial: serialParam,
      package: z.string().describe("e.g. com.example.app"),
      activity: z.string().optional().describe("Optional fully-qualified activity, e.g. .MainActivity"),
    },
  },
  async ({ serial, package: pkg, activity }) => {
    const s = await resolveSerial(serial);
    if (activity) {
      const out = await shell(s, ["am", "start", "-n", `${pkg}/${activity}`]);
      return text(out.trim());
    }
    const out = await shell(s, [
      "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1",
    ]);
    if (/No activities found/i.test(out)) return text(`No launcher activity found for ${pkg}`);
    return text(`Launched ${pkg}`);
  }
);

server.registerTool(
  "terminate_app",
  {
    description: "Force-stop a running app",
    inputSchema: { serial: serialParam, package: z.string() },
  },
  async ({ serial, package: pkg }) => {
    const s = await resolveSerial(serial);
    await shell(s, ["am", "force-stop", pkg]);
    return text(`Terminated ${pkg}`);
  }
);

server.registerTool(
  "clear_app_data",
  {
    description: "Clear all data and permissions for an app (like a fresh install)",
    inputSchema: { serial: serialParam, package: z.string() },
  },
  async ({ serial, package: pkg }) => {
    const s = await resolveSerial(serial);
    const out = await shell(s, ["pm", "clear", pkg]);
    return text(`App data cleared for ${pkg}: ${out.trim()}`);
  }
);

server.registerTool(
  "grant_permission",
  {
    description: "Grant a runtime permission to an app (e.g. android.permission.CAMERA)",
    inputSchema: { serial: serialParam, package: z.string(), permission: z.string() },
  },
  async ({ serial, package: pkg, permission }) => {
    const s = await resolveSerial(serial);
    const out = await shell(s, ["pm", "grant", pkg, permission]);
    return text(out.trim() || `Granted ${permission} to ${pkg}`);
  }
);

// ── screen ──────────────────────────────────────────────────────────────────

server.registerTool(
  "screenshot",
  {
    description:
      "Take a screenshot of the device screen. Saves a full-resolution PNG and returns a downscaled copy inline (the text notes the scale factor to map back to device pixels).",
    inputSchema: {
      serial: serialParam,
      output_path: z.string().default("/tmp/android-screenshot.png"),
      return_image: z.boolean().default(true).describe("Also return the image inline"),
      inline_max_px: z.number().default(800).describe("Longest side of the inline image; 0 = full resolution"),
    },
  },
  async ({ serial, output_path, return_image, inline_max_px }) => {
    const s = await resolveSerial(serial);
    const png = await runBinary(ADB, ["-s", s, "exec-out", "screencap", "-p"]);
    writeFileSync(output_path, png);
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: `Screenshot saved to ${output_path}` }];
    if (return_image) {
      let inline = png;
      const dims = pngSize(png);
      if (inline_max_px > 0 && dims && Math.max(dims.w, dims.h) > inline_max_px && process.platform === "darwin") {
        const tmp = join(tmpdir(), `android-mcp-inline-${process.pid}.png`);
        try {
          await run("sips", ["-Z", String(inline_max_px), output_path, "--out", tmp]);
          inline = readFileSync(tmp);
          const scale = inline_max_px / Math.max(dims.w, dims.h);
          content[0] = {
            type: "text",
            text: `Screenshot saved to ${output_path} (${dims.w}x${dims.h} px). Inline image is scaled by ${scale.toFixed(4)}; divide inline coordinates by that to get device pixels.`,
          };
        } catch {
          /* fall back to full-size image */
        } finally {
          rmSync(tmp, { force: true });
        }
      }
      content.push({ type: "image", data: inline.toString("base64"), mimeType: "image/png" });
    }
    return { content };
  }
);

server.registerTool(
  "describe_ui",
  {
    description:
      "Get the UI hierarchy of the current screen as a compact JSON list with text, content descriptions, resource IDs, bounds and tap centers (pixels). By default only elements with text/desc or that are interactive are returned.",
    inputSchema: {
      serial: serialParam,
      include_all: z.boolean().default(false).describe("Include every node, not just interesting ones"),
      raw_xml: z.boolean().default(false).describe("Return the raw uiautomator XML instead"),
    },
  },
  async ({ serial, include_all, raw_xml }) => {
    const s = await resolveSerial(serial);
    const xml = await uiDump(s);
    if (raw_xml) return text(xml);
    return text(JSON.stringify(parseUiDump(xml, include_all), null, 1));
  }
);

server.registerTool(
  "find_element",
  {
    description: "Find UI elements whose text, content description or resource ID contains the given string (case-insensitive). Returns bounds and tap centers.",
    inputSchema: { serial: serialParam, query: z.string() },
  },
  async ({ serial, query }) => {
    const s = await resolveSerial(serial);
    const q = query.toLowerCase();
    const matches = parseUiDump(await uiDump(s), true).filter(
      (n) =>
        n.text?.toLowerCase().includes(q) ||
        n.contentDesc?.toLowerCase().includes(q) ||
        n.resourceId?.toLowerCase().includes(q)
    );
    return text(matches.length ? JSON.stringify(matches, null, 1) : `No element matching "${query}"`);
  }
);

// ── input ───────────────────────────────────────────────────────────────────

server.registerTool(
  "tap",
  {
    description: "Tap at x,y pixel coordinates on the screen",
    inputSchema: { serial: serialParam, x: z.number(), y: z.number() },
  },
  async ({ serial, x, y }) => {
    const s = await resolveSerial(serial);
    await shell(s, ["input", "tap", String(Math.round(x)), String(Math.round(y))]);
    return text(`Tapped (${x}, ${y})`);
  }
);

server.registerTool(
  "long_press",
  {
    description: "Long-press at x,y pixel coordinates",
    inputSchema: {
      serial: serialParam,
      x: z.number(),
      y: z.number(),
      duration_ms: z.number().default(800),
    },
  },
  async ({ serial, x, y, duration_ms }) => {
    const s = await resolveSerial(serial);
    const px = String(Math.round(x));
    const py = String(Math.round(y));
    await shell(s, ["input", "swipe", px, py, px, py, String(Math.round(duration_ms))]);
    return text(`Long-pressed (${x}, ${y}) for ${duration_ms}ms`);
  }
);

server.registerTool(
  "swipe",
  {
    description: "Swipe from one point to another (pixels)",
    inputSchema: {
      serial: serialParam,
      x1: z.number(), y1: z.number(),
      x2: z.number(), y2: z.number(),
      duration_ms: z.number().default(300).describe("Swipe duration in milliseconds"),
    },
  },
  async ({ serial, x1, y1, x2, y2, duration_ms }) => {
    const s = await resolveSerial(serial);
    await shell(s, [
      "input", "swipe",
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(Math.round(duration_ms)),
    ]);
    return text(`Swiped (${x1},${y1}) → (${x2},${y2})`);
  }
);

server.registerTool(
  "type_text",
  {
    description: "Type text into the currently focused input field",
    inputSchema: { serial: serialParam, text: z.string() },
  },
  async ({ serial, text: t }) => {
    const s = await resolveSerial(serial);
    // `input text` treats %s as a space; quote for the device shell.
    await shell(s, ["input", "text", shq(t.replace(/ /g, "%s"))]);
    return text(`Typed: ${t}`);
  }
);

server.registerTool(
  "press_button",
  {
    description: `Press a hardware/navigation button (${Object.keys(BUTTONS).join(", ")})`,
    inputSchema: {
      serial: serialParam,
      button: z.enum(Object.keys(BUTTONS) as [keyof typeof BUTTONS, ...(keyof typeof BUTTONS)[]]),
    },
  },
  async ({ serial, button }) => {
    const s = await resolveSerial(serial);
    await shell(s, ["input", "keyevent", BUTTONS[button]]);
    return text(`Pressed ${button}`);
  }
);

server.registerTool(
  "key_event",
  {
    description: "Send any Android keycode (e.g. KEYCODE_ESCAPE, 66) — for keys not covered by press_button",
    inputSchema: { serial: serialParam, keycode: z.string() },
  },
  async ({ serial, keycode }) => {
    const s = await resolveSerial(serial);
    await shell(s, ["input", "keyevent", keycode]);
    return text(`Sent ${keycode}`);
  }
);

server.registerTool(
  "open_url",
  {
    description: "Open a URL or deep link in the device",
    inputSchema: { serial: serialParam, url: z.string() },
  },
  async ({ serial, url }) => {
    const s = await resolveSerial(serial);
    const out = await shell(s, ["am", "start", "-a", "android.intent.action.VIEW", "-d", shq(url)]);
    return text(out.trim() || `Opened ${url}`);
  }
);

server.registerTool(
  "shake",
  {
    description: "Shake the device (emulator only — simulates accelerometer motion, e.g. to open the React Native dev menu)",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    const pattern = ["30:9.81:0", "-30:9.81:0", "30:9.81:0", "-30:9.81:0", "0:9.81:0"];
    for (const v of pattern) {
      await adb(s, ["emu", "sensor", "set", "acceleration", v]);
      await sleep(80);
    }
    return text("Device shaken");
  }
);

server.registerTool(
  "set_orientation",
  {
    description: "Rotate the screen",
    inputSchema: {
      serial: serialParam,
      orientation: z.enum(["portrait", "landscape", "reverse_portrait", "reverse_landscape"]),
    },
  },
  async ({ serial, orientation }) => {
    const s = await resolveSerial(serial);
    const rot = { portrait: 0, landscape: 1, reverse_portrait: 2, reverse_landscape: 3 }[orientation];
    await shell(s, ["settings", "put", "system", "accelerometer_rotation", "0"]);
    await shell(s, ["settings", "put", "system", "user_rotation", String(rot)]);
    return text(`Orientation set to ${orientation}`);
  }
);

// ── media & location ────────────────────────────────────────────────────────

server.registerTool(
  "set_location",
  {
    description: "Set the simulated GPS location (emulator only)",
    inputSchema: { serial: serialParam, latitude: z.number(), longitude: z.number() },
  },
  async ({ serial, latitude, longitude }) => {
    const s = await resolveSerial(serial);
    // Note: the emulator console takes longitude first.
    await adb(s, ["emu", "geo", "fix", String(longitude), String(latitude)]);
    return text(`Location set to ${latitude}, ${longitude}`);
  }
);

server.registerTool(
  "add_media",
  {
    description: "Add a photo or video to the device's media library (Photos/Gallery)",
    inputSchema: {
      serial: serialParam,
      file_path: z.string().describe("Absolute path to image or video file"),
    },
  },
  async ({ serial, file_path }) => {
    const s = await resolveSerial(serial);
    const name = file_path.split("/").pop()!;
    const remote = `/sdcard/Pictures/${name}`;
    await adb(s, ["push", file_path, remote]);
    await shell(s, [
      "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${remote}`,
    ]);
    return text(`Media added: ${remote}`);
  }
);

server.registerTool(
  "record_video",
  {
    description: "Start recording the device screen (max 3 minutes per recording). Call stop_recording to finish and pull the .mp4.",
    inputSchema: {
      serial: serialParam,
      output_path: z.string().default("/tmp/android-recording.mp4"),
    },
  },
  async ({ serial, output_path }) => {
    const s = await resolveSerial(serial);
    if (recordings.has(s)) return text("Already recording");
    const remotePath = `/sdcard/mcp-recording-${Date.now()}.mp4`;
    const proc = spawn(ADB, ["-s", s, "shell", "screenrecord", remotePath], { stdio: "ignore" });
    recordings.set(s, { proc, remotePath, outputPath: output_path });
    return text(`Recording started → ${output_path}`);
  }
);

server.registerTool(
  "stop_recording",
  {
    description: "Stop an active screen recording and save the video locally",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    const rec = recordings.get(s);
    if (!rec) return text("No active recording");
    recordings.delete(s);
    // Ask screenrecord on the device to stop gracefully so it finalises the file.
    await shell(s, ["pkill", "-INT", "screenrecord"]).catch(() => {});
    await new Promise<void>((resolve) => {
      if (rec.proc.exitCode !== null) return resolve();
      rec.proc.once("exit", () => resolve());
      setTimeout(() => { rec.proc.kill(); resolve(); }, 5000);
    });
    await sleep(500);
    await adb(s, ["pull", rec.remotePath, rec.outputPath]);
    await shell(s, ["rm", rec.remotePath]).catch(() => {});
    return text(`Recording saved to ${rec.outputPath}`);
  }
);

// ── status bar (SystemUI demo mode) ─────────────────────────────────────────

async function demo(serial: string, kv: string[]): Promise<void> {
  await shell(serial, ["am", "broadcast", "-a", "com.android.systemui.demo", ...kv]);
}

server.registerTool(
  "set_status_bar",
  {
    description: "Override the status bar via SystemUI demo mode (time, battery, wifi, notifications)",
    inputSchema: {
      serial: serialParam,
      time: z.string().optional().describe("Time string e.g. '9:41' or '12:00'"),
      battery_level: z.number().min(0).max(100).optional(),
      battery_charging: z.boolean().optional(),
      wifi_level: z.number().min(0).max(4).optional().describe("Wifi signal bars, 0-4"),
      hide_notifications: z.boolean().optional(),
    },
  },
  async ({ serial, time, battery_level, battery_charging, wifi_level, hide_notifications }) => {
    const s = await resolveSerial(serial);
    await shell(s, ["settings", "put", "global", "sysui_demo_allowed", "1"]);
    await demo(s, ["-e", "command", "enter"]);
    if (time) {
      const [h, m] = time.split(":");
      await demo(s, ["-e", "command", "clock", "-e", "hhmm", `${h.padStart(2, "0")}${(m ?? "00").padStart(2, "0")}`]);
    }
    if (battery_level !== undefined || battery_charging !== undefined) {
      const kv = ["-e", "command", "battery"];
      if (battery_level !== undefined) kv.push("-e", "level", String(battery_level));
      if (battery_charging !== undefined) kv.push("-e", "plugged", String(battery_charging));
      await demo(s, kv);
    }
    if (wifi_level !== undefined) {
      await demo(s, ["-e", "command", "network", "-e", "wifi", "show", "-e", "level", String(wifi_level), "-e", "fully", "true"]);
    }
    if (hide_notifications !== undefined) {
      await demo(s, ["-e", "command", "notifications", "-e", "visible", String(!hide_notifications)]);
    }
    return text("Status bar updated");
  }
);

server.registerTool(
  "clear_status_bar",
  {
    description: "Exit demo mode and restore the real status bar",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    await demo(s, ["-e", "command", "exit"]);
    return text("Status bar cleared");
  }
);

// ── logs ────────────────────────────────────────────────────────────────────

server.registerTool(
  "logcat",
  {
    description: "Read recent logcat output, optionally filtered by a regex or restricted to one app's process",
    inputSchema: {
      serial: serialParam,
      lines: z.number().default(200).describe("Number of most recent lines"),
      filter: z.string().optional().describe("Case-insensitive regex applied to each line"),
      package: z.string().optional().describe("Only show logs from this app's process"),
    },
  },
  async ({ serial, lines, filter, package: pkg }) => {
    const s = await resolveSerial(serial);
    const args = ["logcat", "-d", "-v", "time"];
    if (pkg) {
      const pid = (await shell(s, ["pidof", pkg]).catch(() => "")).trim();
      if (!pid) return text(`${pkg} is not running`);
      args.push("--pid", pid.split(" ")[0]);
    }
    let out = await adb(s, args);
    let all = out.split("\n");
    if (filter) {
      const re = new RegExp(filter, "i");
      all = all.filter((l) => re.test(l));
    }
    return text(all.slice(-lines).join("\n") || "(no matching log lines)");
  }
);

server.registerTool(
  "clear_logcat",
  {
    description: "Clear the logcat buffer",
    inputSchema: { serial: serialParam },
  },
  async ({ serial }) => {
    const s = await resolveSerial(serial);
    await adb(s, ["logcat", "-c"]);
    return text("Logcat cleared");
  }
);

// ── start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
