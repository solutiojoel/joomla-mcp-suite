'use strict';

module.exports = {
  id: 'create-article',
  name: 'Create Article',
  description: 'Create a new article in a category and log the change.',
  icon: '📝',
  inputs: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    {
      key: 'catid',
      label: 'Category',
      type: 'site_select',
      required: true,
      source: {
        tool: 'joomla_list_categories',
        args: {},
        resultPath: 'categories',
        labelKey: 'title',
        valueKey: 'id',
      },
    },
    { key: 'introtext', label: 'Intro / Body Text', type: 'textarea', required: false },
    {
      key: 'state',
      label: 'Publish State',
      type: 'select',
      required: false,
      default: '1',
      options: [
        { label: 'Published', value: '1' },
        { label: 'Unpublished', value: '0' },
      ],
    },
  ],
  steps: [
    {
      label: 'Read site notes',
      tool: 'get_site_notes',
      args: {},
    },
    {
      label: 'Create article',
      tool: 'joomla_create_article',
      args: {
        title: '{{title}}',
        catid: '{{catid}}',
        introtext: '{{introtext}}',
        state: '{{state}}',
      },
    },
    {
      label: 'Log change',
      tool: 'append_site_note',
      args: {
        note: '### {{date}} — Article created: {{title}}\n**Requested by:** dashboard | **Ticket:** none\n**Changes:**\n- Created article "{{title}}" in category {{catid}}\n**Notes:** No follow-up needed',
      },
    },
  ],
};
