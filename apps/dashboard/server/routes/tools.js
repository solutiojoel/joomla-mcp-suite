'use strict';

const express = require('express');
const mcp = require('../mcp-client.js');

const router = express.Router();

// GET /api/tools — list all available tools with their schemas
router.get('/', async (req, res) => {
  try {
    const tools = await mcp.listTools();
    res.json({ ok: true, tools });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tools/call  { name, args }
router.post('/call', async (req, res) => {
  const { name, args } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  try {
    const result = await mcp.callTool(name, args || {});
    res.json({ ok: true, text: result.text, content: result.content, isError: result.isError });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
