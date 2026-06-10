'use strict';

const express = require('express');
const mcp = require('../mcp-client.js');

const router = express.Router();

// GET /api/sites/active
router.get('/active', async (req, res) => {
  try {
    const result = await mcp.callTool('get_active_site', {});
    res.json({ ok: true, text: result.text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/sites/active  { url }
router.post('/active', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const result = await mcp.callTool('set_active_site', { url });
    res.json({ ok: true, text: result.text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sites/notes
router.get('/notes', async (req, res) => {
  try {
    const result = await mcp.callTool('get_site_notes', {});
    res.json({ ok: true, text: result.text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
