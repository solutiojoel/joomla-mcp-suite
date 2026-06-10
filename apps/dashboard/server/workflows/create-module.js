'use strict';

module.exports = {
  id: 'create-module',
  name: 'Create Module',
  description: 'Create a new module and assign it to a position.',
  icon: '🧩',
  inputs: [
    { key: 'title',    label: 'Module Title', type: 'text', required: true },
    {
      key: 'module',
      label: 'Module Type',
      type: 'site_select',
      required: true,
      source: {
        tool: 'joomla_list_module_types',
        args: {},
        resultPath: 'types',
        labelKey: 'name',
        valueKey: 'element',
      },
    },
    {
      key: 'position',
      label: 'Position',
      type: 'site_select',
      required: false,
      source: {
        tool: 'joomla_list_module_positions',
        args: {},
        resultPath: 'positions',
        labelKey: 'position',
        valueKey: 'position',
      },
    },
    {
      key: 'published',
      label: 'Published',
      type: 'select',
      required: false,
      default: '1',
      options: [
        { label: 'Yes', value: '1' },
        { label: 'No',  value: '0' },
      ],
    },
  ],
  steps: [
    {
      label: 'Create module',
      tool: 'joomla_create_module',
      args: {
        title:     '{{title}}',
        module:    '{{module}}',
        position:  '{{position}}',
        published: '{{published}}',
      },
    },
    {
      label: 'Log change',
      tool: 'append_site_note',
      args: {
        note: '### {{date}} — Module created: {{title}}\n**Requested by:** dashboard | **Ticket:** none\n**Changes:**\n- Created module "{{title}}" (type: {{module}}) at position {{position}}\n**Notes:** No follow-up needed',
      },
    },
  ],
};
