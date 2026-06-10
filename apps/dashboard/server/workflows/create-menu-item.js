'use strict';

module.exports = {
  id: 'create-menu-item',
  name: 'Create Menu Item',
  description: 'Add a new item to an existing menu.',
  icon: '🔗',
  inputs: [
    {
      key: 'menutype',
      label: 'Menu',
      type: 'site_select',
      required: true,
      source: {
        tool: 'joomla_list_menus',
        args: {},
        resultPath: 'menus',
        labelKey: 'title',
        valueKey: 'menutype',
      },
    },
    { key: 'title', label: 'Item Title', type: 'text', required: true },
    { key: 'link',  label: 'URL / Route', type: 'text', required: true,
      placeholder: 'e.g. index.php?option=com_content&view=article&id=42 or https://example.com' },
    {
      key: 'parent_id',
      label: 'Parent Item ID (0 = top level)',
      type: 'text',
      required: false,
      default: '1',
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
      label: 'Create menu item',
      tool: 'joomla_create_menu_item',
      args: {
        menutype:  '{{menutype}}',
        title:     '{{title}}',
        link:      '{{link}}',
        parent_id: '{{parent_id}}',
        published: '{{published}}',
      },
    },
    {
      label: 'Log change',
      tool: 'append_site_note',
      args: {
        note: '### {{date}} — Menu item created: {{title}}\n**Requested by:** dashboard | **Ticket:** none\n**Changes:**\n- Added menu item "{{title}}" to menu {{menutype}}\n**Notes:** No follow-up needed',
      },
    },
  ],
};
