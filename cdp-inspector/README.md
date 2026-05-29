# cdp-inspector — MCP Server

Chrome DevTools Protocol element inspector with FTP CSS upload. Lets Claude inspect live DOM elements, read computed styles, extract CSS rules, and push CSS directly to your server.

---

## Quick start

### 1. Install dependencies

```bash
cd cdp-inspector
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key fields:

| Variable | Description |
|---|---|
| `CHROME_PORT` | Remote debugging port (default 9222) |
| `CHROME_PATH` | Path to Chrome exe (auto-detected if blank) |
| `BRIDGE_PORT` | Bridge server port (default 9224) |
| `FTP_HOST` | Your hosting server hostname |
| `FTP_USER` | FTP username |
| `FTP_PASSWORD` | FTP password |
| `FTP_SECURE` | `true` for FTPS, `false` for plain FTP |
| `FTP_DEFAULT_CSS_PATH` | Default remote CSS file path |

### 3. Launch Chrome with remote debugging enabled

**Windows (PowerShell):**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

> If you skip this step, `browser_connect` will launch a separate headless Chrome automatically.

### 4. Register as an MCP server in Claude

Add to your `claude.json` (or `.mcp.json` in your project):

```json
{
  "mcpServers": {
    "cdp-inspector": {
      "command": "node",
      "args": ["C:/joomla-mcp-suite/cdp-inspector/index.js"]
    }
  }
}
```

Restart Claude — the 11 tools will appear automatically.

---

## Available tools

### Browser

| Tool | Description |
|---|---|
| `browser_connect` | Attach to Chrome or launch headless |
| `browser_disconnect` | Disconnect / close browser |
| `page_navigate` | Navigate to a URL |
| `page_screenshot` | Screenshot current viewport |
| `browser_evaluate` | Run JS expression in page |

### Element inspection

| Tool | Description |
|---|---|
| `element_inspect` | Tag, classes, attrs, dimensions, text |
| `element_get_styles` | Computed CSS values |
| `element_get_css_rules` | All matched stylesheet rules + specificity |
| `element_get_selector` | Generate a unique CSS selector |
| `dom_query` | querySelector / querySelectorAll |

### CSS & FTP

| Tool | Description |
|---|---|
| `css_upload_ftp` | Upload CSS to remote file (replace or append) |
| `css_test_ftp` | Verify FTP connection |

### Extension bridge

| Tool | Description |
|---|---|
| `extension_get_element` | Get element captured by right-click context menu |

---

## Typical workflow

```
1. browser_connect
2. page_navigate  { url: "https://yoursite.com/page" }
3. page_screenshot                          ← see the page
4. element_inspect { selector: ".mod-nav" } ← get dimensions/classes
5. element_get_css_rules { selector: ".mod-nav" }  ← see what rules apply
6. element_get_selector  { selector: ".mod-nav" }  ← get the precise selector
7. css_upload_ftp {
     css: ".mod-nav { background: #1e1b4b; }",
     remotePath: "/templates/g5_hydrogen/custom/css/custom.css",
     mode: "append"
   }
8. page_navigate  { url: "..." }  ← reload and verify
9. page_screenshot
```

---

## Browser extension

See `../inspector-extension/` for the companion Chrome extension.

Install it via **chrome://extensions → Load unpacked**, then right-click any element and choose **"Inspect with Claude"**. Element data is posted to the bridge server and retrieved with `extension_get_element`.

The bridge server starts automatically when the MCP server starts (port 9224).
