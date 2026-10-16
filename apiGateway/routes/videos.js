const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");
const auth = require("../auth/auth");

const router = express.Router();
const usersURL = "https://users:10001/";
const storageURL = "http://img_storage:11000/videos/";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function storageHeaders(req, contentType) {
  return {
    "x-internal-service-token": process.env.INTERNAL_SERVICE_TOKEN,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function forwardError(res, error) {
  const status = error.response?.status || 500;
  return res.status(status).json(error.response?.data || { error: "Video service unavailable." });
}

async function loadUser(req) {
  const response = await axios.get(`${usersURL}validate/${req.params.user}`, {
    httpsAgent,
    headers: { Authorization: req.headers.authorization },
  });
  return response.data.user;
}

router.post("/:user/uploads", auth.checkToken, async (req, res) => {
  try {
    const user = await loadUser(req);
    if (user.type === "anonymous") {
      return res.status(403).json({ error: "Sign in with a registered account to upload videos." });
    }
    const response = await axios.post(
      `${storageURL}${req.params.user}/uploads`,
      { ...req.body, userType: user.type },
      { headers: storageHeaders(req) },
    );
    return res.status(response.status).json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.put(
  "/:user/uploads/:videoId/parts/:partNumber",
  auth.checkToken,
  bodyParser.raw({ type: "application/octet-stream", limit: "9mb" }),
  async (req, res) => {
    try {
      const response = await axios.put(
        `${storageURL}${req.params.user}/uploads/${req.params.videoId}/parts/${req.params.partNumber}`,
        req.body,
        {
          params: { uploadId: req.query.uploadId },
          headers: storageHeaders(req, "application/octet-stream"),
          maxBodyLength: 9 * 1024 * 1024,
        },
      );
      return res.status(response.status).json(response.data);
    } catch (error) {
      return forwardError(res, error);
    }
  },
);

router.post("/:user/uploads/:videoId/complete", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.post(
      `${storageURL}${req.params.user}/uploads/${req.params.videoId}/complete`,
      req.body,
      { headers: storageHeaders(req) },
    );
    return res.status(response.status).json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.delete("/:user/uploads/:videoId", auth.checkToken, async (req, res) => {
  try {
    await axios.delete(`${storageURL}${req.params.user}/uploads/${req.params.videoId}`, {
      headers: storageHeaders(req),
    });
    return res.sendStatus(204);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.get("/:user", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.get(`${storageURL}${req.params.user}`, { headers: storageHeaders(req) });
    return res.json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.get("/:user/:videoId", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.get(`${storageURL}${req.params.user}/${req.params.videoId}`, {
      headers: storageHeaders(req),
    });
    return res.json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.delete("/:user/:videoId", auth.checkToken, async (req, res) => {
  try {
    await axios.delete(`${storageURL}${req.params.user}/${req.params.videoId}`, {
      headers: storageHeaders(req),
    });
    return res.sendStatus(204);
  } catch (error) {
    return forwardError(res, error);
  }
});

// Trim endpoints (UC-VID-004)
router.post("/:user/:videoId/trim", auth.checkToken, async (req, res) => {
  let charged = false;
  try {
    const user = await loadUser(req);
    if (user.type === "anonymous") {
      return res.status(403).json({ error: "Sign in with a registered account to edit videos." });
    }

    // Debita provisoriamente 1 operação para utilizadores Registados (free)
    if (user.type !== "premium") {
      try {
        await axios.get(`${usersURL}${req.params.user}/process/1`, {
          httpsAgent,
          headers: { Authorization: req.headers.authorization },
        });
        charged = true;
      } catch (quotaError) {
        return res.status(403).json({
          error: "A sua quota diária (5/5) foi atingida. Tente amanhã ou atualize para Premium.",
        });
      }
    }

    try {
      const response = await axios.post(
        `${storageURL}${req.params.user}/${req.params.videoId}/trim`,
        { ...req.body, userType: user.type },
        { headers: storageHeaders(req) },
      );
      return res.status(response.status).json(response.data);
    } catch (storageError) {
      if (charged) {
        await axios
          .post(
            `${usersURL}${req.params.user}/process/refund/1`,
            {},
            { httpsAgent, headers: { Authorization: req.headers.authorization } },
          )
          .catch(() => {});
      }
      return forwardError(res, storageError);
    }
  } catch (error) {
    return forwardError(res, error);
  }
});

router.get("/:user/tasks", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.get(`${storageURL}${req.params.user}/tasks`, {
      headers: storageHeaders(req),
    });
    return res.json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.get("/:user/tasks/:taskId", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.get(
      `${storageURL}${req.params.user}/tasks/${req.params.taskId}`,
      { headers: storageHeaders(req) },
    );
    return res.json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

router.post("/:user/tasks/:taskId/cancel", auth.checkToken, async (req, res) => {
  try {
    const response = await axios.post(
      `${storageURL}${req.params.user}/tasks/${req.params.taskId}/cancel`,
      {},
      { headers: storageHeaders(req) },
    );
    return res.status(response.status).json(response.data);
  } catch (error) {
    return forwardError(res, error);
  }
});

module.exports = router;
