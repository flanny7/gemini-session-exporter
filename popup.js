document.getElementById('export-md').addEventListener('click', () => runExport('md'));
document.getElementById('export-json').addEventListener('click', () => runExport('json'));

async function runExport(format) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    alert('タブが取得できませんでした');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAndDownloadChat,
      args: [format]
    });
  } catch (err) {
    alert('スクリプトの実行に失敗しました: ' + err.message);
  }
}

function extractAndDownloadChat(format) {
  function nodeToMarkdown(node, depth = 0, listIndex = null) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tag = node.tagName.toLowerCase();

    // 不要なUI要素を除外
    const ignoreTags = [
      'button', 'mat-icon', 'sources-carousel', 'citation-anchor',
      'suggested-queries', 'source-container', 'mat-ripple'
    ];
    if (
      ignoreTags.includes(tag) ||
      node.classList.contains('cdk-visually-hidden') ||
      node.classList.contains('citation') ||
      node.classList.contains('elicitations-container') ||
      node.classList.contains('step-index') ||
      node.classList.contains('step-duration') ||
      node.closest('.step-header-container') === node ||
      tag === 'step-header'
    ) {
      return '';
    }

    // 1. 数式 (KaTeX / MathJax)
    if (node.classList.contains('katex') || node.classList.contains('math-inline') || tag === 'math-inline') {
      const texElem = node.querySelector('annotation');
      if (texElem) {
        return '$' + texElem.textContent.trim() + '$';
      }
    }
    if (node.classList.contains('katex-display') || node.classList.contains('math-block') || tag === 'math-block') {
      const texElem = node.querySelector('annotation');
      if (texElem) {
        return '\n\n$$' + texElem.textContent.trim() + '$$\n\n';
      }
    }
    if (node.classList.contains('katex-html') || tag === 'math') {
      return '';
    }

    // 2. コードブロック
    if (tag === 'pre' || tag === 'code-block') {
      const codeElem = node.querySelector('code') || node;
      const langHeader = node.querySelector('.code-block-decoration, .header-text');
      const lang = langHeader ? langHeader.textContent.trim().toLowerCase() : '';
      const codeText = codeElem.textContent.replace(/^\n+|\n+$/g, '');
      return '\n\n```' + lang + '\n' + codeText + '\n```\n\n';
    }

    // 3. テーブル（表組み）
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      let tableMd = '\n\n';
      rows.forEach((tr, rowIndex) => {
        const cells = Array.from(tr.querySelectorAll('th, td'));
        const rowText = cells.map(cell => cell.textContent.trim().replace(/\|/g, '\\|')).join(' | ');
        tableMd += '| ' + rowText + ' |\n';

        if (rowIndex === 0) {
          const separator = cells.map(() => '---').join(' | ');
          tableMd += '| ' + separator + ' |\n';
        }
      });
      return tableMd + '\n';
    }

    // 4. リンク
    if (tag === 'a') {
      const href = node.getAttribute('href');
      const text = node.textContent.trim();
      return href ? '[' + text + '](' + href + ')' : text;
    }

    // 5. リスト構造（階層・順序付き対応）
    if (tag === 'ul' || tag === 'ol') {
      const isOrdered = tag === 'ol';
      let listMd = '\n';
      let idx = 1;
      Array.from(node.children).forEach(child => {
        if (child.tagName.toLowerCase() === 'li') {
          listMd += nodeToMarkdown(child, depth + 1, isOrdered ? idx++ : null);
        }
      });
      return listMd + '\n';
    }

    if (tag === 'li') {
      const indent = '  '.repeat(Math.max(0, depth - 1));
      const prefix = listIndex !== null ? (listIndex + '. ') : '* ';

      let itemContent = '';
      let subLists = '';
      node.childNodes.forEach(child => {
        const childTag = child.nodeType === Node.ELEMENT_NODE ? child.tagName.toLowerCase() : '';
        if (childTag === 'ul' || childTag === 'ol') {
          subLists += nodeToMarkdown(child, depth);
        } else {
          itemContent += nodeToMarkdown(child, depth);
        }
      });
      return indent + prefix + itemContent.trim() + '\n' + subLists;
    }

    // 6. 子ノードの再帰走査
    let inner = '';
    node.childNodes.forEach(child => {
      inner += nodeToMarkdown(child, depth);
    });

    switch (tag) {
      case 'h1': return '\n\n# ' + inner.trim() + '\n\n';
      case 'h2': return '\n\n## ' + inner.trim() + '\n\n';
      case 'h3': return '\n\n### ' + inner.trim() + '\n\n';
      case 'h4': return '\n\n#### ' + inner.trim() + '\n\n';
      case 'p': return '\n\n' + inner.trim() + '\n\n';
      case 'strong':
      case 'b': return '**' + inner.trim() + '**';
      case 'em':
      case 'i': return '*' + inner.trim() + '*';
      case 'del':
      case 's':
      case 'strike': return '~~' + inner.trim() + '~~';
      case 'code': return '`' + inner + '`';
      case 'hr': return '\n\n---\n\n';
      case 'br': return '\n';
      case 'blockquote': return '\n\n> ' + inner.trim().replace(/\n/g, '\n> ') + '\n\n';
      default: return inner;
    }
  }

  const userQueries = document.querySelectorAll('user-query');
  const modelResponses = document.querySelectorAll('model-response');
  const chatData = [];
  const maxLen = Math.max(userQueries.length, modelResponses.length);

  for (let i = 0; i < maxLen; i++) {
    // ユーザー発言の抽出
    if (i < userQueries.length) {
      const uNode = userQueries[i];
      const paragraphs = uNode.querySelectorAll('.query-text p, .query-content p, p');
      let cleanUserText = '';

      if (paragraphs.length > 0) {
        cleanUserText = Array.from(paragraphs)
          .map(p => p.textContent.trim())
          .filter(Boolean)
          .join('\n\n');
      } else {
        const textElem = uNode.querySelector('.query-text, .query-content') || uNode;
        cleanUserText = textElem.textContent.trim();
      }

      cleanUserText = cleanUserText.replace(/^あなたのプロンプト\s*/i, '').trim();

      const half = Math.floor(cleanUserText.length / 2);
      const part1 = cleanUserText.slice(0, half).trim();
      const part2 = cleanUserText.slice(half).trim();
      if (part1 && part1 === part2) {
        cleanUserText = part1;
      }

      if (cleanUserText) {
        chatData.push({ role: 'user', text: cleanUserText });
      }
    }

    // モデル発言の抽出
    if (i < modelResponses.length) {
      const mNode = modelResponses[i];
      const contentElem = mNode.querySelector('.message-content') || mNode;

      let cleanModelText = nodeToMarkdown(contentElem);

      cleanModelText = cleanModelText
        .replace(/^Gemini\s*の回答\s*/i, '')
        .replace(/\d+([^\n*]+)\d+(?:分|秒)\s*\*\*(\d+\.[^*]+)\*\*(\d+(?:分|秒))/g, '**$2** ($3)')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (cleanModelText) {
        chatData.push({ role: 'model', text: cleanModelText });
      }
    }
  }

  if (chatData.length === 0) {
    alert('チャット内容が取得できませんでした。');
    return;
  }

  const title = document.title.replace(/[\/\\:*?"<>|]/g, '_').trim() || 'gemini-chat';
  let content = '';
  const filename = title + '.' + format;

  if (format === 'json') {
    content = JSON.stringify({ title, exportedAt: new Date().toISOString(), messages: chatData }, null, 2);
  } else {
    content = '# ' + title + '\n\nExported at: ' + new Date().toLocaleString() + '\n\n---\n\n';
    chatData.forEach((msg) => {
      const speaker = msg.role === 'user' ? '### User' : '### Gemini';
      content += speaker + '\n\n' + msg.text + '\n\n---\n\n';
    });
  }

  const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}