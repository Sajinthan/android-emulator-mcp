# android-emulator-mcp

An MCP (Model Context Protocol) server that lets AI agents control the Android Emulator — boot AVDs, install apps, interact with UI, take screenshots, read logs, and more. Companion to [ios-simulator-mcp](https://github.com/Sajinthan/ios-simulator-mcp).

Everything is driven by `adb` and the `emulator` binary — no extra daemons needed.

## Prerequisites

- Android SDK with `platform-tools` (adb) and `emulator` installed (e.g. via Android Studio)
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` set, or the SDK at `~/Library/Android/sdk`
- Node.js 18+

## Installation

```bash
git clone https://github.com/Sajinthan/android-emulator-mcp
cd android-emulator-mcp
pnpm install
pnpm build
```

## Connect to Claude Code / Claude Desktop / Kiro

```bash
claude mcp add --scope user android-emulator node /absolute/path/to/android-emulator-mcp/dist/index.js
```

Or add to your MCP config JSON:

```json
{
  "mcpServers": {
    "android-emulator": {
      "command": "node",
      "args": ["/absolute/path/to/android-emulator-mcp/dist/index.js"]
    }
  }
}
```

## Tools

The `serial` parameter (e.g. `emulator-5554`) is optional on every tool when exactly one device is connected.

### Emulator Control
| Tool | Description |
|---|---|
| `list_emulators` | List AVDs, running emulators and connected devices |
| `boot_emulator` | Boot an AVD by name and wait for boot to complete |
| `shutdown_emulator` | Shut down a running emulator |
| `get_booted_serial` | Get serials of connected devices |
| `get_screen_info` | Screen size (px), density and rotation |

### App Management
| Tool | Description |
|---|---|
| `install_app` | Install an `.apk` (grants runtime permissions) |
| `uninstall_app` | Uninstall by package name |
| `list_apps` | List installed packages |
| `launch_app` | Launch by package name (or a specific activity) |
| `terminate_app` | Force-stop an app |
| `clear_app_data` | Wipe app data and permissions |
| `grant_permission` | Grant a runtime permission |

### UI Interaction
| Tool | Description |
|---|---|
| `tap` | Tap at x,y pixels |
| `long_press` | Long-press at x,y |
| `swipe` | Swipe between two points |
| `type_text` | Type into the focused input |
| `press_button` | HOME, BACK, MENU, APP_SWITCH, POWER, VOLUME_UP/DOWN, ENTER, DEL, TAB, CAMERA, SEARCH |
| `key_event` | Send any Android keycode |
| `describe_ui` | Compact JSON UI hierarchy with bounds and tap centers |
| `find_element` | Find elements by text / content-desc / resource-id |
| `shake` | Shake the device (accelerometer, e.g. RN dev menu) |
| `set_orientation` | Rotate to portrait / landscape |

### Media & Location
| Tool | Description |
|---|---|
| `screenshot` | Save a PNG and return it inline (downscaled) |
| `record_video` | Start screen recording (max 3 min) |
| `stop_recording` | Stop recording and pull the `.mp4` |
| `add_media` | Push a photo/video into the media library |
| `open_url` | Open a URL or deep link |
| `set_location` | Set simulated GPS coordinates |

### Status Bar (SystemUI demo mode)
| Tool | Description |
|---|---|
| `set_status_bar` | Override time, battery, wifi, notifications |
| `clear_status_bar` | Exit demo mode |

### Logs
| Tool | Description |
|---|---|
| `logcat` | Recent logcat, filterable by regex or package |
| `clear_logcat` | Clear the logcat buffer |

## Coordinate System

Unlike iOS, Android's `adb input` uses **physical pixels**, which is the same space as screenshots and `describe_ui` bounds — no scaling needed. The `screenshot` tool returns a downscaled inline image to save context; its text response states the scale factor if you want to map inline coordinates back to device pixels. Prefer `describe_ui` / `find_element` for exact tap targets.
