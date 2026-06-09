// File app.js ini khusus untuk memancing cPanel menjalankan npm start
require('child_process').execSync('npm run start', { stdio: 'inherit' });
