const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1400, height: 900 });
  const errs = [];
  w.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2 && !/Security Warning|unsafe-eval|electronjs.org|packaged|consult/.test(message)) {
      errs.push(message + ' @ ' + src + ':' + line);
    }
  });
  await w.loadURL('http://localhost:5174/demo/doc-viewer');
  await new Promise((r) => setTimeout(r, 7000));
  const info = await w.webContents.executeJavaScript(`
    (() => {
      const root = document.getElementById('root');
      return { len: root ? root.innerHTML.length : -1,
               text: (document.body.innerText || '').slice(0, 300),
               path: location.pathname };
    })()
  `).catch((e) => ({ err: e.message }));
  console.log('INFO ' + JSON.stringify(info, null, 1));
  console.log('ERRORS(' + errs.length + '):\n' + errs.slice(0, 12).join('\n'));
  app.exit(0);
});
