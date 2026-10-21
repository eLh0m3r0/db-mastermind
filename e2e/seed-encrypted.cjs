// Writes a connections.json with a password encrypted by the real OS keychain (as the GUI would).
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
app.setName('DB Mastermind')
const dir = process.argv.at(-1)
app.whenReady().then(() => {
  const enc = 'enc:v1:' + safeStorage.encryptString('mastermind').toString('base64')
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify([{ id: 'pg1', name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: enc, database: 'mastermind', createdAt: '', updatedAt: '' }]))
  app.quit()
})
