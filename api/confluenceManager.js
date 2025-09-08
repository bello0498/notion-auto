// confluenceManager.js

const fetch = require('node-fetch');

// 🔍 1. 제목 기반 검색 함수
async function searchConfluence({ query, spaceKey = '', limit = 5, statusFilter = '', tagFilter = [] }) {
  const apiToken = process.env.CONFLUENCE_API_TOKEN;
  const baseUrl = 'https://your-domain.atlassian.net/wiki';

  const url = new URL(baseUrl + '/rest/api/content/search');
  url.searchParams.append('cql', `title ~ "${query}"` + (spaceKey ? ` AND space = "${spaceKey}"` : ''));
  url.searchParams.append('limit', limit);
  url.searchParams.append('expand', 'version,metadata.labels');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${Buffer.from('email@example.com:' + apiToken).toString('base64')}`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) throw new Error(`Confluence API Error: ${res.status}`);

  const data = await res.json();

  let pages = data.results.map(page => {
    const labels = page.metadata?.labels?.results || [];
    const status = labels.find(l => l.prefix === 'status')?.name || '미정';
    const tags = labels.map(l => l.name).filter(name => !name.startsWith('status')) || [];

    return {
      id: page.id,
      title: page.title,
      url: `${baseUrl}/pages/${page.id}`,
      lastEdited: page.version?.when,
      status,
      tags
    };
  });

  if (statusFilter) pages = pages.filter(p => p.status === statusFilter);
  if (tagFilter.length > 0) pages = pages.filter(p => tagFilter.every(tag => p.tags.includes(tag)));

  return pages;
}

// 🧠 2. 가장 유사한 제목 자동 선택
function findBestMatchingPage(pages, query) {
  const q = query.toLowerCase();
  return pages.sort((a, b) => {
    const aScore = a.title.toLowerCase().includes(q) ? 1 : 0;
    const bScore = b.title.toLowerCase().includes(q) ? 1 : 0;
    return bScore - aScore || new Date(b.lastEdited) - new Date(a.lastEdited);
  })[0];
}

// ✏️ 3. 문서 본문 업데이트
async function updateConfluenceContent(pageId, newContent) {
  const apiToken = process.env.CONFLUENCE_API_TOKEN;
  const baseUrl = 'https://your-domain.atlassian.net/wiki';

  // 먼저 기존 버전 가져오기
  const res = await fetch(`${baseUrl}/rest/api/content/${pageId}?expand=version`, {
    headers: {
      'Authorization': `Basic ${Buffer.from('email@example.com:' + apiToken).toString('base64')}`,
      'Accept': 'application/json'
    }
  });
  const page = await res.json();

  const body = {
    version: { number: page.version.number + 1 },
    title: page.title,
    type: 'page',
    body: {
      storage: {
        value: newContent,
        representation: 'storage'
      }
    }
  };

  const updateRes = await fetch(`${baseUrl}/rest/api/content/${pageId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${Buffer.from('email@example.com:' + apiToken).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!updateRes.ok) throw new Error(`Confluence Update Error: ${updateRes.status}`);
  return await updateRes.json();
}

module.exports = {
  searchConfluence,
  findBestMatchingPage,
  updateConfluenceContent
};
