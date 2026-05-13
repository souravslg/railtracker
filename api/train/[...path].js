export default async function handler(req, res) {
  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join('/') : path;
  
  // Construct the target URL on api.railradar.in
  const targetUrl = new URL(`https://api.railradar.in/${pathStr}`);
  
  // Forward all query parameters except 'path'
  Object.keys(req.query).forEach(key => {
    if (key !== 'path') {
      targetUrl.searchParams.append(key, req.query[key]);
    }
  });

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        'Referer': 'https://railradar.in/',
        'Origin': 'https://railradar.in/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error: ${response.status}`, errorText);
      return res.status(response.status).json({ error: 'Upstream error', status: response.status });
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return res.status(200).json(data);
    } else {
      const text = await response.text();
      console.error('Non-JSON response from upstream:', text.slice(0, 200));
      return res.status(502).json({ error: 'Upstream returned non-JSON response', details: text.slice(0, 200) });
    }
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Proxy Internal Error', message: error.message });
  }
}
