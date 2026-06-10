'use strict';

module.exports = {
  id: 'update-article',
  name: 'Update Article',
  description: 'Fetch an existing article, update its title or body, and log the change.',
  icon: '✏️',
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
    { key: 'title',     label: 'New Title (leave blank to keep)',     type: 'text',     required: false },
    { key: 'introtext', label: 'New Body Text (leave blank to keep)', type: 'textarea', required: false },
  ],
  steps: [
    {
      label: 'Fetch article',
      tool: 'joomla_get_article',
      args: { id: '{{article_id}}' },
    },
    {
      label: 'Update article',
      tool: 'joomla_update_article',
      args: {
        id: '{{article_id}}',
        title: '{{title}}',
        introtext: '{{introtext}}',
      },
    },
    {
      label: 'Log change',
      tool: 'append_site_note',
      args: {
        note: '### {{date}} — Article updated (ID {{article_id}})\n**Requested by:** dashboard | **Ticket:** none\n**Changes:**\n- Updated article ID {{article_id}}\n**Notes:** No follow-up needed',
      },
    },
  ],
};
