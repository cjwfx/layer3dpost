const express = require("express");

const path = require("path");

const multer = require("multer");

const Stripe = require("stripe");

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

  fileFilter: function (req, file, cb) {

    const name = file.originalname.toLowerCase();

    if (name.endsWith(".stl") || name.endsWith(".3mf")) {

      cb(null, true);

    } else {

      cb(new Error("Only STL and 3MF files are accepted."));

    }

  }

});

app.post("/api/upload", upload.single("model"), function (req, res) {

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

app.post("/api/create-checkout-session", async function (req, res) {

  try {

    if (!process.env.STRIPE_SECRET_KEY) {

      return res.status(500).json({

        error: "Stripe has not been configured yet."

      });

    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const basket = req.body.basket;

    if (!Array.isArray(basket) || basket.length === 0) {

      return res.status(400).json({

        error: "Basket is empty."

      });

    }

    const materialMultipliers = {

      PLA: 1,

      PETG: 1.25,

      TPU: 1.45,

      "PLA-CF": 1.6

    };

    const qualityMultipliers = {

      Standard: 1,

      Fine: 1.25,

      "High detail": 1.5

    };

    const basePrice = 9.95;

    const lineItems = basket.map(function (item) {

      const materialMultiplier =

        materialMultipliers[item.material];

      const qualityMultiplier =

        qualityMultipliers[item.quality];

      if (!materialMultiplier || !qualityMultiplier) {

        throw new Error("Invalid print configuration.");

      }

      const quantity = Math.max(

        1,

        Math.min(100, Number(item.quantity) || 1)

      );

      const unitPrice =

        basePrice *

        materialMultiplier *

        qualityMultiplier;

      return {

        price_data: {

          currency: "gbp",

          product_data: {

            name: item.filename,

            description:

              item.material +

              " · " +

              item.colour +

              " · " +

              item.quality

          },

          unit_amount: Math.round(unitPrice * 100)

        },

        quantity: quantity

      };

    });

    lineItems.push({

      price_data: {

        currency: "gbp",

        product_data: {

          name: "UK Tracked Delivery"

        },

        unit_amount: 449

      },

      quantity: 1

    });

    const baseUrl =

      req.protocol + "://" + req.get("host");

    const session =

      await stripe.checkout.sessions.create({

        mode: "payment",

        line_items: lineItems,

        success_url:

          baseUrl + "/?payment=success",

        cancel_url:

          baseUrl + "/?payment=cancelled",

        billing_address_collection: "required",

        shipping_address_collection: {

          allowed_countries: ["GB"]

        },

        customer_creation: "always"

      });

    res.json({

      url: session.url

    });

  } catch (error) {

    console.error("Stripe checkout error:", error);

    res.status(500).json({

      error:

        error.message ||

        "Unable to create checkout."

    });

  }

});

app.get("/health", function (req, res) {

  res.json({

    status: "ok",

    service: "Layer3DPost"

  });

});

app.use(function (err, req, res, next) {

  console.error(err);

  res.status(400).json({

    success: false,

    error: err.message

  });

});

app.listen(PORT, "0.0.0.0", function () {

  console.log(

    "Layer3DPost running on port " + PORT

  );

});