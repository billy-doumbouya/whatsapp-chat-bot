import QRCode from "qrcode";
import {
  getCurrentQR,
  getConnectionStatus,
} from "../services/whatsapp.client.js";

export async function getQRPage(req, res) {
  const isConnected = getConnectionStatus();

  // Déjà connecté — pas besoin de QR
  if (isConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1 style="color:#25D366">✅ WhatsApp connecté !</h1>
        <p>Le bot est actif et répond aux messages.</p>
      </body></html>
    `);
  }

  const qr = getCurrentQR();

  // QR pas encore généré
  if (!qr) {
    return res.send(`
      <html>
      <head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h2>⏳ Génération du QR en cours...</h2>
        <p>La page se rafraîchit automatiquement.</p>
      </body></html>
    `);
  }

  // Génère le QR comme image PNG base64
  const qrImage = await QRCode.toDataURL(qr, {
    width: 400,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  res.send(`
    <html>
    <head>
      <meta http-equiv="refresh" content="20">
      <title>Scanner QR WhatsApp</title>
    </head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
      <h2 style="color:#25D366">📱 Scanner ce QR avec WhatsApp</h2>
      <p>WhatsApp → ⋮ → Appareils connectés → Connecter un appareil</p>
      <img src="${qrImage}" style="border:8px solid white;border-radius:12px;margin:20px auto;display:block"/>
      <p style="color:#aaa;font-size:14px">⚠️ Le QR expire toutes les 20 secondes — la page se rafraîchit automatiquement</p>
    </body>
    </html>
  `);
}
