'use strict';

/**
 * Workflow step runner.
 *
 * A workflow definition:
 * {
 *   id: 'create-article',
 *   name: 'Create Article',
 *   description: '...',
 *   icon: '📝',
 *   inputs: [
 *     { key: 'title', label: 'Title', type: 'text', required: true },
 *     { key: 'catid', label: 'Category', type: 'site_select',
 *       source: { tool: 'joomla_list_categories', resultPath: 'categories',
 *                 labelKey: 'title', valueKey: 'id' } },
 *   ],
 *   steps: [
 *     { label: 'Read site notes', tool: 'get_site_notes', args: {} },
 *     { label: 'Create article',  tool: 'joomla_create_article',
 *       args: { title: '{{title}}', catid: '{{catid}}' } },
 *     { label: 'Log change',      tool: 'append_site_note',
 *       args: { note: '### {{date}} — Article created: {{title}}' } },
 *   ]
 * }
 *
 * Variable interpolation in step args:
 *   {{key}}           — from user inputs
 *   {{date}}          — today's date (YYYY-MM-DD)
 *   {{step_N.text}}   — text output of step N (0-indexed)
 *   {{step_N.field}}  — parsed JSON field from step N output
 */

const mcp = require('../mcp-client.js');

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Interpolate {{variables}} in a value (string, object, or array).
 * context: { ...userInputs, date, step_0, step_1, ... }
 */
function interpolate(value, context) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const parts = key.trim().split('.');
      let v = context;
      for (const p of parts) {
        if (v == null) return '';
        v = v[p];
      }
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => interpolate(v, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, context);
    return out;
  }
  return value;
}

/**
 * Run a workflow, emitting progress via the `emit` callback.
 *
 * emit({ type: 'step_start',    index, label, tool, args })
 * emit({ type: 'step_done',     index, label, text, isError })
 * emit({ type: 'step_error',    index, label, error })
 * emit({ type: 'workflow_done', steps })
 * emit({ type: 'workflow_error', error })
 */
async function runWorkflow(workflow, userInputs, emit) {
  const context = { ...userInputs, date: today() };
  const stepResults = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const args = interpolate(step.args || {}, context);
    const label = interpolate(step.label || step.tool, context);

    emit({ type: 'step_start', index: i, label, tool: step.tool, args });

    try {
      const result = await mcp.callTool(step.tool, args);
      let parsed = {};
      try { parsed = JSON.parse(result.text); } catch {}

      const stepCtx = { text: result.text, ...parsed };
      context[`step_${i}`] = stepCtx;
      stepResults.push({ index: i, label, tool: step.tool, text: result.text, isError: result.isError });

      emit({ type: 'step_done', index: i, label, text: result.text, isError: result.isError });

      if (result.isError && step.stopOnError !== false) {
        emit({ type: 'workflow_error', error: `Step "${label}" returned an error`, steps: stepResults });
        return;
      }
    } catch (err) {
      stepResults.push({ index: i, label, tool: step.tool, error: err.message });
      emit({ type: 'step_error', index: i, label, error: err.message });
      emit({ type: 'workflow_error', error: err.message, steps: stepResults });
      return;
    }
  }

  emit({ type: 'workflow_done', steps: stepResults });
}

/**
 * Resolve a `site_select` input: call the source tool and map results to options.
 */
async function resolveSiteSelect(input) {
  if (!input.source) return [];
  const result = await mcp.callTool(input.source.tool, input.source.args || {});
  let data;
  try { data = JSON.parse(result.text); } catch { return []; }

  // Navigate to the array via resultPath (e.g. 'categories' or 'items')
  const arr = input.source.resultPath ? data[input.source.resultPath] : data;
  if (!Array.isArray(arr)) return [];

  return arr.map(item => ({
    label: item[input.source.labelKey || 'title'],
    value: String(item[input.source.valueKey || 'id']),
  }));
}

module.exports = { runWorkflow, resolveSiteSelect, interpolate };
