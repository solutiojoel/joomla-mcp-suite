'use strict';

module.exports = {
  id: 'publish-article',
  name: 'Publish / Unpublish Article',
  description: 'Toggle the publish state of an existing article.',
  icon: '🔄',
  inputs: [
    {
      key: 'article_id',
      label: 'Article',
      type: 'site_select',
      required: true,
      source: {
        tool: 'joomla_list_articles',
        args: {},
        resultPath: 'articles',
        labelKey: 'title',
        valueKey: 'id',
      },
    },
    {
      key: 'state',
      label: 'New State',
      type: 'select',
      required: true,
      default: '1',
      options: [
        { label: 'Published',   value: '1' },
        { label: 'Unpublished', value: '0' },
        { label: 'Archived',    value: '2' },
        { label: 'Trashed',     value: '-2' },
      ],
    },
  ],
  steps: [
    {
      label: 'Update article state',
      tool: 'joomla_update_article',
      args: { id: '{{article_id}}', state: '{{state}}' },
    },
    {
      label: 'Log change',
      tool: 'append_site_note',
      args: {
        note: '### {{date}} — Article state changed (ID {{article_id}})\n**Requested by:** dashboard | **Ticket:** none\n**Changes:**\n- Set article ID {{article_id}} state to {{state}}\n**Notes:** No follow-up needed',
      },
    },
  ],
};
