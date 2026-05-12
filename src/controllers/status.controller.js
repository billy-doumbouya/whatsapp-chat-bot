export async function getStatus(req, res) {
  res.json({
    success: true,
    status: "online",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
