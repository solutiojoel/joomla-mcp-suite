'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const http    = require('http');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const mcp       = require('./mcp-client.js');
const registry  = require('./workflows/index.js');
const { runWorkflow } = require('./workflows/_base.js');

const sitesRouter     = require('./routes/sites.js');
const toolsRouter     = require('./routes/tools.js');
const workflowsRouter = require('./routes/workflows.js');

const PORT = parseInt(process.env.DASHBOARD_PORT || '18305', 10);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Serve the React SPA
app.use(express.static(path.join(__dirname, '..', 'client')));

// API routes
app.use('/api/sites',     sitesRouter);
app.use('/api/tools',     toolsRouter);
app.use('/api/workflows', workflowsRouter);

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'joomla-dashboard' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // { type: 'run_workflow', workflowId, inputs }
    if (msg.type === 'run_workflow') {
      const wf = registry.get(msg.workflowId);
      if (!wf) {
        ws.send(JSON.stringify({ type: 'workflow_error', error: 'Unknown workflow: ' + msg.workflowId }));
        return;
      }

      function emit(event) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      }

      await runWorkflow(wf, msg.inputs || {}, emit);
    }

    // { type: 'call_tool', name, args }  (used by Tool Explorer live preview)
    if (msg.type === 'call_tool') {
      try {
        const result = await mcp.callTool(msg.name, msg.args || {});
        ws.send(JSON.stringify({ type: 'tool_result', name: msg.name, text: result.text, isError: result.isError }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'tool_error', name: msg.name, error: err.message }));
      }
    }
  });

  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[dashboard] Listening on http://0.0.0.0:${PORT}`);
  // Pre-connect to orchestrator so first UI load is fast
  try {
    await mcp.connect();
  } catch (err) {
    console.warn('[dashboard] Could not pre-connect to orchestrator:', err.message);
  }
});
