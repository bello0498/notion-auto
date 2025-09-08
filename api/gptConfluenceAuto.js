// api/gptConfluenceAuto.js

import { searchConfluence, findBestMatchingPage, updateConfluenceContent } from './confluenceManager';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { target, actions } = req.body;
    if (!target || !Array.isArray(actions)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const pages = await searchConfluence({ query: target });
    if (!pages.length) {
      return res.status(404).json({ error: `No pages found for target '${target}'` });
    }

    const parentPage = findBestMatchingPage(pages, target);
    const updatedPages = [];

    for (const action of actions) {
      if (action.type === 'modify') {
        if (action.scope === 'parent') {
          await updateConfluenceContent(parentPage.id, action.content);
          updatedPages.push({ id: parentPage.id, title: parentPage.title, url: parentPage.url, scope: 'parent' });

        } else if (action.scope === 'child') {
          // Fetch child pages
          const resChild = await fetch(`https://your-domain.atlassian.net/wiki/rest/api/content/${parentPage.id}/child/page`, {
            headers: {
              'Authorization': `Basic ${Buffer.from('email@example.com:' + process.env.CONFLUENCE_API_TOKEN).toString('base64')}`,
              'Accept': 'application/json'
            }
          });

          const childData = await resChild.json();
          const matchedChild = (childData.results || []).find(p => p.title === action.title);

          if (matchedChild) {
            await updateConfluenceContent(matchedChild.id, action.content);
            updatedPages.push({ id: matchedChild.id, title: matchedChild.title, url: `${parentPage.url}/child/${matchedChild.id}`, scope: 'child' });
          } else {
            updatedPages.push({ title: action.title, scope: 'child', error: 'Child page not found' });
          }
        }
      }
    }

    return res.status(200).json({ ok: true, updatedPages });
  } catch (err) {
    console.error('Confluence auto update error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
