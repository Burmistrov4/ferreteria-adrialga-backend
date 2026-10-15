const b = 'http://localhost:3000/api';
(async () => {
  const h = await fetch(b + '/health');
  console.log('health', h.status, await h.text());
  const r = await fetch(b + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  console.log('login', r.status);
  console.log(await r.text());
})().catch(e => console.error('ERR', e.message));
