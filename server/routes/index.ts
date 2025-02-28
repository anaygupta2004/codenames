app.post("/api/games/:gameId/ai/clue", async (req, res) => {
  try {
    // ... existing code ...
    res.json(result);
    // There might be a cleanup call here or in a middleware
  } catch (error) {
    console.error("Error in AI clue route:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}); 