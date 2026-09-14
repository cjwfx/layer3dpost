const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Layer3DPost" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Layer3DPost running on port ${PORT}`);
});
