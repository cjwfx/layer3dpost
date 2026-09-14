const express = require("express");
const path = require("path");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: "/tmp/layer3dpost/",
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();

    if (name.endsWith(".stl") || name.endsWith(".3mf")) {
      cb(null, true);
    } else {
      cb(new Error("Only STL and 3MF files are accepted."));
    }
  }
});

app.post("/api/upload", upload.single("model"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "No model file uploaded."
    });
  }

  res.json({
    success: true,
    filename: req.file.originalname,
    uploadId: req.file.filename
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Layer3DPost"
  });
});

app.use((err, req, res, next) => {
  res.status(400).json({
    success: false,
    error: err.message
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Layer3DPost running on port ${PORT}`);
});
