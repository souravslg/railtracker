export default async function handler(req, res) {
  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join('/') : path;
  
  // Construct the target URL on railradar.in
  // We remove the 'api/v1' from the incoming path because we'll add it back or handle it.
  // Actually, let's just proxy exactly what comes in.
  const targetUrl = new URL(`https://railradar.in/${pathStr}`);
  
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

    const data = await response.json();
    
    // Set CORS headers just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
}
