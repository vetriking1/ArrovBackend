import express from "express";
import cors from "cors";

import cancelIrnRoute from "./routes/cancelrnRoute.js";
import generateIrnRoute from "./routes/generateIrnRoute.js";
import regenerateIrnRoute from "./routes/regenerateIrnRoute.js";
import generateCreditNoteIrnRoute from "./routes/generateCreditNoteIrnRoute.js";
import cancelCreditNoteIrnRoute from "./routes/cancelCreditNoteIrnRoute.js";
import regenerateCreditNoteIrnRoute from "./routes/regenerateCreditNoteIrnRoute.js";
import getIpRoute from "./routes/ipAddressRetrievalRoute.js";

const app = express();

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
  "http://localhost:3000",
  "https://aarov.vercel.app",
  "http://10.57.35.3:3000",
];

app.use(
  cors({
    origin: allowedOrigins,
  })
);

app.use("/api/cancelIrn", cancelIrnRoute);
app.use("/api/generateIrn", generateIrnRoute);
app.use("/api/regenerateIrn", regenerateIrnRoute);
app.use("/api/generateCreditNoteIrn", generateCreditNoteIrnRoute);
app.use("/api/cancelCreditNoteIrn", cancelCreditNoteIrnRoute);
app.use("/api/regenerateCreditNoteIrn", regenerateCreditNoteIrnRoute);
app.use("/api/checkIp", getIpRoute);

app.get("/", (req, res) => {
  res.send("This is Invoice Server");
});

app.listen(process.env.PORT, () => {
  console.log(`Server Running in port ${process.env.PORT}`);
});
