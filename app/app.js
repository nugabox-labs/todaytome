const path = require("path");
require("dotenv").config({
  override: true,
  path: path.resolve(__dirname, ".env"),
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const router = require("./src/router");
const { prisma } = require("./src/db");

const app = express();
const port = Number(process.env.PORT) || 3927;
const publicDir = path.resolve(__dirname, "public");

app.set("trust proxy", true);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "data:"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use(router);
app.use(express.static(publicDir, { index: "index.html" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "internal server error",
    },
  });
});

async function start() {
  await prisma.$connect();
  app.listen(port, () => {
    console.log(`todaytome-api listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
