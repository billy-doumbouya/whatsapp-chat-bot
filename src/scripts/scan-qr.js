import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

async function scanQR() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  console.log("🔍 Starting QR scan... version:", version.join("."));
  console.log("📱 Open WhatsApp → Linked Devices → Link a Device\n");

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["WhatsApp AI Bot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(
        "\n📱 Scanne ce QR avec WhatsApp → Appareils connectés → Connecter un appareil\n",
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("\n✅ Connected! Auth session saved to /auth");
      console.log("🚀 You can now run: npm start\n");
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error("❌ Logged out. Try again.");
        process.exit(1);
      }
    }
  });
}

scanQR();
