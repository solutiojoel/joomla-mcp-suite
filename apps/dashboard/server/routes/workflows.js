'use strict';

const express = require('express');
const registry = require('../workflows/index.js');
const { resolveSiteSelect } = require('../workflows/_base.js');

const router = express.Router();

// GET /api/workflows — list all workflows
router.get('/', (req, res) => {
  res.json({ ok: true, workflows: registry.list() });
});

// GET /api/workflows/:id — full workflow definition (with inputs resolved)
router.get('/:id', async (req, res) => {
  const wf = registry.get(req.params.id);
  if (!wf) return res.status(404).json({ ok: false, error: 'Workflow not found' });

  // Resolve site_select inputs so the frontend can populate dropdowns
  const inputs = await Promise.all(
    (wf.inputs || []).map(async input => {
      if (input.type === 'site_select') {
        try {
          const options = await resolveSiteSelect(input);
          return { ...input, options };
        } catch (err) {
          return { ...input, options: [], error: err.message };
        }
      }
      return input;
    })
  );

  res.json({ ok: true, workflow: { ...wf, inputs } });
});

// Workflow execution happens over WebSocket (see index.js).
// This endpoint exists only for metadata.

module.exports = router;
