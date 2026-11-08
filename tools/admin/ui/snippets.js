/**
 * tools/admin/ui/snippets.js —— 编辑器的代码片段库
 * ---------------------------------------------------------------------------
 * 想增删片段直接改这里：每个片段是 { label, text, select? }。
 *   label  按钮上显示的名字
 *   text   插入到光标处的内容（Markdown 或 Hexo/HTML 常用写法）
 *   select 插入后自动选中的文字，方便直接改写（可选）
 */
window.MD_SNIPPETS = [
  {
    group: '提示框',
    items: [
      {
        label: '信息提示',
        text: '> **提示**\n> 这里写提示内容',
        select: '这里写提示内容'
      },
      {
        label: '注意警告',
        text: '> **注意**\n> 这里写需要注意的事项',
        select: '这里写需要注意的事项'
      },
      {
        label: '成功 / 失败',
        text: '> **完成**：这里写成功说明\n\n> **失败**：这里写失败原因',
        select: '这里写成功说明'
      },
      {
        label: '引用卡片',
        text: '> 引用的一段话\n>\n> —— 出处',
        select: '引用的一段话'
      }
    ]
  },
  {
    group: '折叠面板',
    items: [
      {
        label: '折叠内容',
        text: '<details>\n<summary>点击展开</summary>\n\n这里写折叠后的内容。\n\n</details>',
        select: '点击展开'
      },
      {
        label: '默认展开',
        text: '<details open>\n<summary>收起</summary>\n\n这里写默认展开的内容。\n\n</details>',
        select: '这里写默认展开的内容。'
      }
    ]
  },
  {
    group: '按钮与链接',
    items: [
      {
        label: '按钮',
        text: '<a class="btn" href="https://example.com">按钮文字</a>',
        select: '按钮文字'
      },
      {
        label: '卡片链接',
        text: '<a class="card-link" href="https://example.com">\n  <strong>标题</strong>\n  <span>说明文字</span>\n</a>',
        select: '标题'
      },
      {
        label: '站内跳转',
        text: '[文章标题](/2026/01/01/文章地址/)',
        select: '文章标题'
      }
    ]
  },
  {
    group: '图片与视频',
    items: [
      {
        label: '图片卡片',
        text: '<figure>\n  <img src="https://example.com/a.png" alt="说明">\n  <figcaption>图片说明</figcaption>\n</figure>',
        select: 'https://example.com/a.png'
      },
      {
        label: '视频',
        text: '<video controls preload="metadata" src="https://example.com/a.mp4"></video>',
        select: 'https://example.com/a.mp4'
      },
      {
        label: '外链视频',
        text: '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD" allowfullscreen></iframe>',
        select: 'BV1xx411c7mD'
      }
    ]
  },
  {
    group: '时间线',
    items: [
      {
        label: '时间线列表',
        text: '- **2026-01-01** 第一件事\n- **2026-02-01** 第二件事\n- **2026-03-01** 第三件事',
        select: '第一件事'
      },
      {
        label: '时间线 HTML',
        text: '<div class="timeline">\n  <div class="timeline-item"><span>2026-01-01</span> 第一件事</div>\n  <div class="timeline-item"><span>2026-02-01</span> 第二件事</div>\n</div>',
        select: '第一件事'
      }
    ]
  },
  {
    group: '表格模板',
    items: [
      {
        label: '两列对照',
        text: '| 项目 | 说明 |\n| --- | --- |\n| 名称 | 描述 |\n| 名称 | 描述 |',
        select: '项目'
      },
      {
        label: '三列数据',
        text: '| 名称 | 数值 | 备注 |\n| --- | --- | --- |\n| A | 1 |  |\n| B | 2 |  |',
        select: '名称'
      }
    ]
  },
  {
    group: '代码块模板',
    items: [
      {
        label: 'JavaScript',
        text: '```js\nfunction hello() {\n  console.log(\'hello\');\n}\n```',
        select: 'hello'
      },
      {
        label: 'Shell 命令',
        text: '```bash\nnpm run build\n```',
        select: 'npm run build'
      },
      {
        label: 'HTML / CSS',
        text: '```html\n<div class="demo">示例</div>\n```',
        select: '示例'
      },
      {
        label: '纯文本',
        text: '```text\n这里写纯文本内容\n```',
        select: '这里写纯文本内容'
      }
    ]
  },
  {
    group: '结构标记',
    items: [
      {
        label: '摘要截断',
        text: '<!-- more -->'
      },
      {
        label: '目录标记',
        text: '<!-- toc -->'
      },
      {
        label: '分隔线',
        text: '\n---\n'
      },
      {
        label: '文章目录（手写）',
        text: '- [第一节](#第一节)\n- [第二节](#第二节)',
        select: '第一节'
      }
    ]
  }
];
