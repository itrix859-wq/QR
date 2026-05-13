const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const path = require("path");
const sharp = require("sharp");

dotenv.config();

let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;
const otpStore = new Map();

app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "QR.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/auth-config", (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
  });
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify().catch((error) => {
  console.warn("Email transporter verification failed:", error.message || error);
});

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanText(value) {
  return String(value || "").trim().replace(/[<>]/g, "");
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanCode(code) {
  return String(code || "").replace(/\D/g, "");
}

function cleanChatId(chatId) {
  return String(chatId || "").trim().replace(/[^A-Za-z0-9_-]/g, "");
}

function cleanImageDataUrl(value) {
  const text = String(value || "").trim();
  return /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(text) ? text : "";
}

function buildChatTitle(prompt) {
  const words = cleanText(prompt).split(/\s+/).filter(Boolean).slice(0, 7);
  return words.join(" ") || "New chat";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function requireFirebaseUser(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      return res.status(401).json({ error: "Sign in is required." });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.authUser = {
      uid: decoded.uid,
      email: decoded.email || "",
    };
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired sign in session." });
  }
}

async function verifyRecaptchaToken(token, remoteIp = "") {
  const siteKey = process.env.RECAPTCHA_SITE_KEY || "";
  const secret = process.env.RECAPTCHA_SECRET_KEY || "";

  if (!siteKey) {
    return { ok: true };
  }

  if (!token) {
    return { ok: false, error: "Please complete the CAPTCHA." };
  }

  if (!secret) {
    return { ok: true };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });

  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));

  if (!payload.success) {
    return { ok: false, error: "CAPTCHA verification failed. Please try again." };
  }

  return { ok: true };
}

function getEmailName(email) {
  const localPart = cleanEmail(email).split("@")[0] || "Customer";
  return localPart.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function saveOtp(type, email, data) {
  const key = `${type}:${email}`;
  otpStore.set(key, {
    ...data,
    type,
    email,
    code: generateCode(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  return otpStore.get(key);
}

function getOtp(type, email) {
  return otpStore.get(`${type}:${email}`);
}

function deleteOtp(type, email) {
  otpStore.delete(`${type}:${email}`);
}

function getEmailLogoPath() {
  const photoLogo = path.join(__dirname, "photos", "logo.png");
  const rootLogo = path.join(__dirname, "QR.png");

  return fs.existsSync(photoLogo) ? photoLogo : rootLogo;
}

function buildEmailTemplate({ name, code, title, message }) {
  return `
    <div style="font-family: Arial, sans-serif; background:#f5f5f5; padding:30px;">
      <div style="max-width:520px; margin:auto; background:white; border-radius:18px; padding:28px; text-align:center; border:1px solid #eee;">
        <img src="cid:qrlogo" alt="QMakerr" style="max-width:120px; margin-bottom:20px;" />
        <h2 style="margin:0 0 14px; color:#111;">Dear ${name},</h2>
        <p style="font-size:17px; color:#111; margin:0 0 8px; font-weight:bold;">${title}</p>
        <p style="font-size:15px; color:#555; margin:0 0 18px;">${message}</p>
        <div style="font-size:34px; font-weight:bold; letter-spacing:8px; color:#111; background:#f2f2f2; padding:18px; border-radius:14px; margin:20px 0;">${code}</div>
        <p style="font-size:14px; color:#666;">This code will expire in 10 minutes.</p>
        <p style="font-size:16px; color:#111; margin-top:24px;">Enjoy!</p>
      </div>
    </div>
  `;
}

async function sendCodeEmail({ to, name, code, subject, title, message }) {
  await transporter.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || "QMakerr"}" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html: buildEmailTemplate({ name, code, title, message }),
    attachments: [
      {
        filename: "QR.png",
        path: getEmailLogoPath(),
        cid: "qrlogo",
      },
    ],
  });
}


function verifyOtpRecord(record, code) {
  if (!record) {
    return { ok: false, error: "No verification code found. Please request a new code." };
  }

  if (Date.now() > record.expiresAt) {
    return { ok: false, error: "Verification code expired. Please request a new code.", expired: true };
  }

  if (record.attempts >= 5) {
    return { ok: false, error: "Too many attempts. Please request a new code.", blocked: true };
  }

  record.attempts += 1;

  if (record.code !== code) {
    return { ok: false, error: "Invalid verification code." };
  }

  return { ok: true };
}

function mapFirebaseSignInError(message = "") {
  if (message.includes("EMAIL_NOT_FOUND")) return "No account found with this email.";
  if (message.includes("INVALID_PASSWORD")) return "Invalid password.";
  if (message.includes("INVALID_LOGIN_CREDENTIALS")) return "Invalid email or password.";
  if (message.includes("USER_DISABLED")) return "This account is disabled.";
  return "Could not sign in. Please try again.";
}

function mapFirebaseGoogleError(message = "") {
  if (message.includes("OPERATION_NOT_ALLOWED")) return "Google sign in is not enabled in Firebase.";
  if (message.includes("INVALID_IDP_RESPONSE")) return "Google sign in was rejected. Please try again.";
  if (message.includes("FEDERATED_USER_ID_ALREADY_LINKED")) return "This Google account is already linked.";
  if (message.includes("EMAIL_EXISTS")) return "This email is already registered with another sign in method.";
  return "Could not sign in with Google. Please try again.";
}

function dataUrlToBuffer(dataUrl) {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid base64 image format");
  }
  return Buffer.from(matches[2], "base64");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createRoundedWhiteBox(size, radius = 18) {
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white"/>
    </svg>
  `;
  return Buffer.from(svg);
}

function normalizeHexColor(hex) {
  if (!hex) return "#111111";

  let value = hex.trim().replace("#", "");

  if (value.length === 3) {
    value = value.split("").map((ch) => ch + ch).join("");
  }

  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    return "#111111";
  }

  return `#${value.toLowerCase()}`;
}

function hexToRgb(hex) {
  const clean = normalizeHexColor(hex).replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function detectQrColorFromDescription(description) {
  const text = (description || "").toLowerCase();
  const hexMatch = text.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/);

  if (hexMatch) {
    return normalizeHexColor(hexMatch[0]);
  }

  const colorMap = [
    {
      keywords: ["gold", "golden", "ذهبي", "دهبي", "ذهب"],
      color: "#7a5c00",
    },
    {
      keywords: ["black", "أسود", "اسود", "سوداء"],
      color: "#111111",
    },
    {
      keywords: ["navy", "dark blue", "blue", "أزرق", "ازرق", "كحلي"],
      color: "#1f3a5f",
    },
    {
      keywords: ["green", "أخضر", "اخضر"],
      color: "#0f5b3a",
    },
    {
      keywords: ["red", "أحمر", "احمر"],
      color: "#7a1111",
    },
    {
      keywords: ["purple", "violet", "بنفسجي", "موف"],
      color: "#4b1f5f",
    },
    {
      keywords: ["pink", "وردي", "زهري"],
      color: "#8a2f5c",
    },
    {
      keywords: ["brown", "coffee", "بني", "قهوة", "قهوي"],
      color: "#5a351d",
    },
    {
      keywords: ["silver", "gray", "grey", "فضي", "رمادي"],
      color: "#4a4a4a",
    },
    {
      keywords: ["orange", "برتقالي"],
      color: "#9a4b00",
    },
  ];

  for (const item of colorMap) {
    if (item.keywords.some((keyword) => text.includes(keyword))) {
      return item.color;
    }
  }

  return "#111111";
}

async function buildColoredQrFromImage(qrBuffer, qrSize, qrColor) {
  const rgb = hexToRgb(qrColor);

  const { data, info } = await sharp(qrBuffer)
    .trim()
    .resize(qrSize, qrSize, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .greyscale()
    .threshold(180)
    .negate()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgbaBuffer = Buffer.alloc(info.width * info.height * 4);

  for (let i = 0; i < info.width * info.height; i += 1) {
    const alpha = data[i];

    rgbaBuffer[i * 4] = rgb.r;
    rgbaBuffer[i * 4 + 1] = rgb.g;
    rgbaBuffer[i * 4 + 2] = rgb.b;
    rgbaBuffer[i * 4 + 3] = alpha;
  }

  return sharp(rgbaBuffer, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

app.post("/sign-in", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const apiKey = process.env.FIREBASE_WEB_API_KEY;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (!password) {
      return res.status(400).json({ error: "Password is required." });
    }

    if (!apiKey) {
      return res.status(500).json({
        error: "Firebase Web API key is missing in .env.",
      });
    }

    const firebaseRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      }
    );
    const payload = await firebaseRes.json();

    if (!firebaseRes.ok) {
      return res.status(400).json({
        error: mapFirebaseSignInError(payload?.error?.message),
      });
    }

    const userRecord = await admin.auth().getUser(payload.localId);

    return res.json({
      success: true,
      message: "Signed in successfully.",
      uid: payload.localId,
      email: payload.email,
      idToken: payload.idToken,
      provider: "password",
      createdAt: userRecord.metadata.creationTime,
      birthday: userRecord.customClaims?.birthday || "",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.post("/google-sign-in", async (req, res) => {
  try {
    const accessToken = cleanText(req.body.accessToken);
    const idToken = cleanText(req.body.idToken);
    const requestUri = cleanText(req.body.requestUri) || `${req.protocol}://${req.get("host")}`;
    const apiKey = process.env.FIREBASE_WEB_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Firebase Web API key is missing in .env.",
      });
    }

    if (!accessToken && !idToken) {
      return res.status(400).json({
        error: "Google credential is required.",
      });
    }

    const postBody = new URLSearchParams({
      providerId: "google.com",
    });

    if (idToken) {
      postBody.set("id_token", idToken);
    } else {
      postBody.set("access_token", accessToken);
    }

    const firebaseRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          postBody: postBody.toString(),
          requestUri,
          returnIdpCredential: true,
          returnSecureToken: true,
        }),
      }
    );
    const payload = await firebaseRes.json();

    if (!firebaseRes.ok) {
      return res.status(400).json({
        error: mapFirebaseGoogleError(payload?.error?.message),
      });
    }

    const userRecord = await admin.auth().getUser(payload.localId);

    return res.json({
      success: true,
      message: "Signed in with Google successfully.",
      uid: payload.localId,
      email: payload.email,
      displayName: payload.displayName || "",
      idToken: payload.idToken,
      provider: "google",
      createdAt: userRecord.metadata.creationTime,
      birthday: userRecord.customClaims?.birthday || "",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.get("/ai-chats", requireFirebaseUser, async (req, res) => {
  try {
    const snapshot = await db
      .collection("users")
      .doc(req.authUser.uid)
      .collection("aiChats")
      .orderBy("updatedAt", "desc")
      .limit(60)
      .get();

    const chats = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title || "New chat",
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || "",
        updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || "",
      };
    });

    return res.json({ chats });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not load chats." });
  }
});

app.get("/ai-chats/:chatId", requireFirebaseUser, async (req, res) => {
  try {
    const chatId = cleanChatId(req.params.chatId);

    if (!chatId) {
      return res.status(400).json({ error: "Valid chat id is required." });
    }

    const chatRef = db
      .collection("users")
      .doc(req.authUser.uid)
      .collection("aiChats")
      .doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "Chat not found." });
    }

    const messagesSnapshot = await chatRef
      .collection("messages")
      .orderBy("createdAt", "asc")
      .limit(80)
      .get();
    const messages = messagesSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        prompt: data.prompt || "",
        image: data.image || "",
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || "",
      };
    });
    const chat = chatDoc.data();

    return res.json({
      chat: {
        id: chatDoc.id,
        title: chat.title || "New chat",
        createdAt: chat.createdAt?.toDate?.()?.toISOString?.() || chat.createdAt || "",
        updatedAt: chat.updatedAt?.toDate?.()?.toISOString?.() || chat.updatedAt || "",
        messages,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not load chat." });
  }
});

app.post("/ai-chats", requireFirebaseUser, async (req, res) => {
  try {
    const prompt = cleanText(req.body.prompt).slice(0, 800);
    const image = cleanImageDataUrl(req.body.image);
    const title = cleanText(req.body.title || buildChatTitle(prompt)).slice(0, 90) || "New chat";

    if (!prompt || !image) {
      return res.status(400).json({ error: "Prompt and image are required." });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const chatRef = db
      .collection("users")
      .doc(req.authUser.uid)
      .collection("aiChats")
      .doc();

    await chatRef.set({
      title,
      createdAt: now,
      updatedAt: now,
    });

    const messageRef = await chatRef.collection("messages").add({
      prompt,
      image,
      createdAt: now,
    });

    return res.json({
      chat: {
        id: chatRef.id,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: messageRef.id,
            prompt,
            image,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not save chat." });
  }
});

app.post("/ai-chats/:chatId/messages", requireFirebaseUser, async (req, res) => {
  try {
    const chatId = cleanChatId(req.params.chatId);
    const prompt = cleanText(req.body.prompt).slice(0, 800);
    const image = cleanImageDataUrl(req.body.image);

    if (!chatId) {
      return res.status(400).json({ error: "Valid chat id is required." });
    }

    if (!prompt || !image) {
      return res.status(400).json({ error: "Prompt and image are required." });
    }

    const chatRef = db
      .collection("users")
      .doc(req.authUser.uid)
      .collection("aiChats")
      .doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "Chat not found." });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const messageRef = await chatRef.collection("messages").add({
      prompt,
      image,
      createdAt: now,
    });
    await chatRef.update({
      updatedAt: now,
    });

    return res.json({
      message: {
        id: messageRef.id,
        prompt,
        image,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not save message." });
  }
});

app.delete("/ai-chats/:chatId", requireFirebaseUser, async (req, res) => {
  try {
    const chatId = cleanChatId(req.params.chatId);

    if (!chatId) {
      return res.status(400).json({ error: "Valid chat id is required." });
    }

    const chatRef = db
      .collection("users")
      .doc(req.authUser.uid)
      .collection("aiChats")
      .doc(chatId);
    const messages = await chatRef.collection("messages").get();
    const batch = db.batch();

    messages.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    batch.delete(chatRef);
    await batch.commit();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not delete chat." });
  }
});

app.post("/send-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const name = cleanText(req.body.name) || getEmailName(email);
    const password = String(req.body.password || "");
    const birthday = cleanText(req.body.birthday);
    const recaptchaToken = cleanText(req.body.recaptchaToken);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const recaptcha = await verifyRecaptchaToken(recaptchaToken, req.ip);

    if (!recaptcha.ok) {
      return res.status(400).json({ error: recaptcha.error });
    }

    try {
      await admin.auth().getUserByEmail(email);
      return res.status(400).json({ error: "This email is already registered." });
    } catch (err) {
      if (err.code !== "auth/user-not-found") {
        throw err;
      }
    }

    const record = saveOtp("signup", email, {
      name,
      password,
      birthday,
    });

    try {
      await sendCodeEmail({
        to: email,
        name,
        code: record.code,
        subject: "Your QMakerr verification code",
        title: "Your verification code is:",
        message: "Use this code to complete your account registration.",
      });
    } catch (error) {
      deleteOtp("signup", email);
      throw error;
    }

    return res.json({
      success: true,
      message: "Verification code sent.",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.post("/verify-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = cleanCode(req.body.code);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (!/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Please enter a valid 6-digit code." });
    }

    const record = getOtp("signup", email);
    const result = verifyOtpRecord(record, code);

    if (!result.ok) {
      if (result.expired || result.blocked) {
        deleteOtp("signup", email);
      }
      return res.status(400).json({ error: result.error });
    }

    const user = await admin.auth().createUser({
      email,
      password: record.password,
      displayName: record.name,
      emailVerified: true,
    });
    await admin.auth().setCustomUserClaims(user.uid, {
      birthday: record.birthday || "",
    });

    deleteOtp("signup", email);

    return res.json({
      success: true,
      message: "Account verified and created successfully.",
      uid: user.uid,
      email,
      createdAt: user.metadata.creationTime,
      birthday: record.birthday || "",
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      return res.status(400).json({ error: "This email is already registered." });
    }

    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.post("/send-reset-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    let user;

    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        return res.status(400).json({ error: "No account found with this email." });
      }
      throw err;
    }

    const name = user.displayName || "Customer";
    const record = saveOtp("reset", email, {
      name,
      uid: user.uid,
    });

    try {
      await sendCodeEmail({
        to: email,
        name,
        code: record.code,
        subject: "Your QMakerr password reset code",
        title: "Your password reset code is:",
        message: "Use this code to reset your password.",
      });
    } catch (error) {
      deleteOtp("reset", email);
      throw error;
    }

    return res.json({
      success: true,
      message: "Password reset code sent.",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = cleanCode(req.body.code);
    const newPassword = String(req.body.newPassword || "");

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (!/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Please enter a valid 6-digit code." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const record = getOtp("reset", email);
    const result = verifyOtpRecord(record, code);

    if (!result.ok) {
      if (result.expired || result.blocked) {
        deleteOtp("reset", email);
      }
      return res.status(400).json({ error: result.error });
    }

    await admin.auth().updateUser(record.uid, {
      password: newPassword,
    });

    deleteOtp("reset", email);

    return res.json({
      success: true,
      message: "Password reset successfully. You can sign in now.",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.post("/generate-ai", async (req, res) => {
  try {
    const { qrImage, description } = req.body;

    if (!qrImage || !description) {
      return res.status(400).json({
        error: "qrImage and description are required",
      });
    }

    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const model = process.env.CF_MODEL || "@cf/black-forest-labs/flux-1-schnell";

    if (!token || !accountId) {
      return res.status(500).json({
        error: "Missing Cloudflare credentials in .env",
      });
    }

    const detectedQrColor = detectQrColorFromDescription(description);
    const scalePercent = 54;
    const sizeRatio = scalePercent / 100;
    const centerAreaPercent = clamp(scalePercent + 6, 42, 76);

    const prompt = `
Create a decorative square template for a QR code design.
User style description: ${description}

Important design rules:
- Leave a large clean empty white square area in the exact center for placing a real QR code later.
- The empty center area should occupy about ${centerAreaPercent}% of the total image width and height.
- Do not draw any fake QR code.
- Do not place text, icons, faces, or important objects in the center.
- Create a beautiful frame around the center QR area.
- Match the decoration and frame colors with this QR color: ${detectedQrColor}.
- High quality, attractive, modern, clean composition.
`.trim();

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

    const cfRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    });

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      return res.status(500).json({
        error: "Cloudflare API error",
        details: errText,
      });
    }

    let aiImageBuffer;
    const contentType = cfRes.headers.get("content-type") || "";

    if (contentType.startsWith("image/")) {
      const arrayBuffer = await cfRes.arrayBuffer();
      aiImageBuffer = Buffer.from(arrayBuffer);
    } else {
      const data = await cfRes.json();

      if (data?.result?.image) {
        aiImageBuffer = Buffer.from(data.result.image, "base64");
      } else {
        return res.status(500).json({
          error: "No image returned from Cloudflare",
          raw: data,
        });
      }
    }

    const qrBuffer = dataUrlToBuffer(qrImage);
    const aiMeta = await sharp(aiImageBuffer).metadata();
    const width = aiMeta.width || 1024;
    const height = aiMeta.height || 1024;
    const baseSize = Math.min(width, height);
    const qrSize = Math.floor(baseSize * sizeRatio);
    const pad = Math.max(12, Math.floor(qrSize * 0.05));
    const whitePadSize = qrSize + pad * 2;
    const qrPrepared = await buildColoredQrFromImage(qrBuffer, qrSize, detectedQrColor);
    const whitePad = createRoundedWhiteBox(whitePadSize, 16);
    const whiteLeft = Math.floor((width - whitePadSize) / 2);
    const whiteTop = Math.floor((height - whitePadSize) / 2);
    const qrLeft = Math.floor((width - qrSize) / 2);
    const qrTop = Math.floor((height - qrSize) / 2);

    const finalBuffer = await sharp(aiImageBuffer)
      .composite([
        {
          input: whitePad,
          left: whiteLeft,
          top: whiteTop,
        },
        {
          input: qrPrepared,
          left: qrLeft,
          top: qrTop,
        },
      ])
      .png()
      .toBuffer();

    const finalBase64 = finalBuffer.toString("base64");
    const finalDataUrl = `data:image/png;base64,${finalBase64}`;

    return res.json({
      image: finalDataUrl,
      qrColor: detectedQrColor,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error",
    });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
