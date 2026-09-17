const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const Stripe = require("stripe");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");


const app = express();

const PORT =
  process.env.PORT || 3000;


/* =========================================================
   STRIPE
========================================================= */

function getStripe() {

  if (!process.env.STRIPE_SECRET_KEY) {

    throw new Error(
      "STRIPE_SECRET_KEY is not configured."
    );
  }

  return new Stripe(
    process.env.STRIPE_SECRET_KEY
  );
}


/* =========================================================
   CLOUDFLARE R2
========================================================= */

function getR2() {

  const requiredVariables = [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET_NAME"
  ];

  for (const variable of requiredVariables) {

    if (!process.env[variable]) {

      throw new Error(
        variable + " is not configured."
      );
    }
  }

  return new S3Client({

    region: "auto",

    endpoint:
      process.env.R2_ENDPOINT,

    credentials: {

      accessKeyId:
        process.env.R2_ACCESS_KEY_ID,

      secretAccessKey:
        process.env.R2_SECRET_ACCESS_KEY
    }
  });
}


async function uploadFileToR2(file) {

  const r2 =
    getR2();

  const originalName =
    String(
      file.originalname || "model"
    );

  const extension =
    path
      .extname(originalName)
      .toLowerCase();

  const randomId =
    crypto.randomUUID();

  const objectKey =
    "uploads/" +
    randomId +
    extension;


  try {

    await r2.send(

      new PutObjectCommand({

        Bucket:
          process.env.R2_BUCKET_NAME,

        Key:
          objectKey,

        Body:
          fs.createReadStream(
            file.path
          ),

        ContentLength:
          file.size,

        ContentType:
          "application/octet-stream",

        Metadata: {

          originalname:
            encodeURIComponent(
              originalName
            )
        }
      })
    );

  }

  finally {

    /*
      Remove the temporary Render copy.

      The permanent copy is now stored
      privately in Cloudflare R2.
    */

    try {

      if (
        file.path &&
        fs.existsSync(file.path)
      ) {

        fs.unlinkSync(
          file.path
        );
      }

    }

    catch (cleanupError) {

      console.error(
        "Temporary file cleanup error:",
        cleanupError
      );
    }
  }


  return objectKey;
}


async function r2ObjectExists(objectKey) {

  if (!objectKey) {
    return false;
  }

  try {

    const r2 =
      getR2();

    await r2.send(

      new HeadObjectCommand({

        Bucket:
          process.env.R2_BUCKET_NAME,

        Key:
          objectKey
      })
    );

    return true;

  }

  catch (error) {

    console.error(
      "R2 object check failed:",
      objectKey,
      error.name || error.message
    );

    return false;
  }
}


async function createModelDownloadUrl(
  objectKey,
  filename
) {

  if (!objectKey) {
    return "";
  }

  const r2 =
    getR2();

  const safeFilename =
    String(
      filename || "model"
    )
      .replace(
        /[\r\n"]/g,
        ""
      )
      .slice(
        0,
        180
      );


  const command =
    new GetObjectCommand({

      Bucket:
        process.env.R2_BUCKET_NAME,

      Key:
        objectKey,

      ResponseContentDisposition:
        'attachment; filename="' +
        safeFilename +
        '"'
    });


  /*
    Secure signed URL.

    604800 seconds = 7 days.

    The bucket itself remains private.
  */

  return await getSignedUrl(
    r2,
    command,
    {
      expiresIn: 604800
    }
  );
}


/* =========================================================
   GENERAL HELPERS
========================================================= */

function escapeHtml(value) {

  return String(value || "")

    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function formatMoney(amount) {

  const value =
    Number(amount || 0) / 100;

  return "£" + value.toFixed(2);
}


function formatAddress(address) {

  if (!address) {

    return "Not supplied";
  }

  return [

    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postal_code,
    address.country

  ]
    .filter(Boolean)
    .join(", ");
}


/* =========================================================
   RESEND
========================================================= */

async function sendResendEmail(options) {

  if (!process.env.RESEND_API_KEY) {

    throw new Error(
      "RESEND_API_KEY is not configured."
    );
  }


  const response =
    await fetch(
      "https://api.resend.com/emails",
      {

        method: "POST",

        headers: {

          "Authorization":
            "Bearer " +
            process.env.RESEND_API_KEY,

          "Content-Type":
            "application/json",

          "User-Agent":
            "Layer3DPost/1.0",

          "Idempotency-Key":
            options.idempotencyKey
        },

        body: JSON.stringify({

          from:
            options.from,

          to:
            options.to,

          subject:
            options.subject,

          html:
            options.html,

          reply_to:
            options.replyTo
        })
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    console.error(
      "Resend error:",
      data
    );

    throw new Error(
      data.message ||
      "Unable to send email."
    );
  }


  return data;
}


/* =========================================================
   STRIPE WEBHOOK

   IMPORTANT:
   MUST BE BEFORE express.json()
========================================================= */

app.post(
  "/api/stripe-webhook",

  express.raw({
    type: "application/json"
  }),

  async function (req, res) {

    let event;


    try {

      if (
        !process.env
          .STRIPE_WEBHOOK_SECRET
      ) {

        throw new Error(
          "STRIPE_WEBHOOK_SECRET is not configured."
        );
      }


      const stripe =
        getStripe();


      const signature =
        req.headers[
          "stripe-signature"
        ];


      event =
        stripe.webhooks
          .constructEvent(

            req.body,

            signature,

            process.env
              .STRIPE_WEBHOOK_SECRET
          );

    }

    catch (error) {

      console.error(
        "Stripe webhook verification failed:",
        error.message
      );


      return res
        .status(400)
        .send(
          "Webhook Error: " +
          error.message
        );
    }


    try {

      const isCompleted =
        event.type ===
        "checkout.session.completed";


      const isAsyncSucceeded =
        event.type ===
        "checkout.session.async_payment_succeeded";


      if (
        isCompleted ||
        isAsyncSucceeded
      ) {

        const stripe =
          getStripe();


        const session =
          event.data.object;


        /*
          Only process orders Stripe
          confirms as paid.
        */

        if (
          session.payment_status !==
          "paid"
        ) {

          console.log(
            "Checkout completed but payment is not yet paid:",
            session.id
          );


          return res.json({
            received: true
          });
        }


        const fullSession =
          await stripe
            .checkout
            .sessions
            .retrieve(
              session.id
            );


        const customerDetails =
          fullSession
            .customer_details ||
          {};


        const shippingDetails =

          (
            fullSession
              .collected_information &&

            fullSession
              .collected_information
              .shipping_details
          )

          ||

          fullSession
            .shipping_details

          ||

          {};


        const customerName =

          shippingDetails.name

          ||

          customerDetails.name

          ||

          "Customer";


        const customerEmail =

          customerDetails.email

          ||

          fullSession.customer_email

          ||

          "";


        const shippingAddress =

          shippingDetails.address

          ||

          customerDetails.address

          ||

          null;


        /* =====================================================
           RECOVER ORDER ITEMS
        ===================================================== */

        const itemCount =
          Math.max(

            0,

            Number(
              fullSession
                .metadata
                ?.item_count
            ) || 0
          );


        const orderItems = [];


        for (
          let index = 0;
          index < itemCount;
          index++
        ) {

          const value =
            fullSession
              .metadata[
                "item_" + index
              ];


          if (!value) {
            continue;
          }


          try {

            orderItems.push(
              JSON.parse(value)
            );

          }

          catch (error) {

            console.error(
              "Unable to parse order metadata:",
              value
            );
          }
        }


        /* =====================================================
           CREATE SECURE DOWNLOAD LINKS
        ===================================================== */

        for (
          const item of orderItems
        ) {

          try {

            item.downloadUrl =
              await createModelDownloadUrl(
                item.uploadId,
                item.filename
              );

          }

          catch (error) {

            console.error(
              "Unable to create model download URL:",
              item.uploadId,
              error
            );

            item.downloadUrl = "";
          }
        }


        /* =====================================================
           ADMIN ORDER TABLE
        ===================================================== */

        let orderRows = "";


        orderItems.forEach(
          function (item) {

            const downloadButton =
              item.downloadUrl

              ?

              `
                <a
                  href="${escapeHtml(
                    item.downloadUrl
                  )}"
                  style="
                    display:inline-block;
                    padding:8px 12px;
                    background:#173d2b;
                    color:#ffffff;
                    text-decoration:none;
                    border-radius:5px;
                    font-weight:bold;
                  "
                >
                  Download model
                </a>
              `

              :

              "Download unavailable";


            orderRows += `

              <tr>

                <td
                  style="
                    padding:10px;
                    border-bottom:
                    1px solid #ddd;
                  "
                >

                  <strong>
                    ${escapeHtml(
                      item.filename
                    )}
                  </strong>

                  <br>

                  <small>

                    ${escapeHtml(
                      item.material
                    )}

                    ·

                    ${escapeHtml(
                      item.colour
                    )}

                    ·

                    ${escapeHtml(
                      item.quality
                    )}

                  </small>

                </td>


                <td
                  style="
                    padding:10px;
                    border-bottom:
                    1px solid #ddd;
                    text-align:center;
                  "
                >

                  ${escapeHtml(
                    item.quantity
                  )}

                </td>


                <td
                  style="
                    padding:10px;
                    border-bottom:
                    1px solid #ddd;
                  "
                >

                  ${downloadButton}

                </td>

              </tr>
            `;
          }
        );


        if (!orderRows) {

          orderRows = `

            <tr>

              <td
                colspan="3"
                style="padding:10px;"
              >

                No item metadata
                was available.

              </td>

            </tr>
          `;
        }


        const orderReference =
          fullSession.id;


        const paymentReference =

          typeof fullSession
            .payment_intent ===
            "string"

          ?

          fullSession
            .payment_intent

          :

          "Not available";


        /* =====================================================
           MERCHANT EMAIL
        ===================================================== */

        const adminEmailHtml = `

          <div
            style="
              font-family:
              Arial,
              Helvetica,
              sans-serif;
              color:#222;
              max-width:700px;
              margin:auto;
            "
          >

            <h1>
              New Layer3DPost Order
            </h1>


            <p>
              A paid order has been
              confirmed by Stripe.
            </p>


            <h2>
              Customer
            </h2>


            <p>

              <strong>Name:</strong>
              ${escapeHtml(
                customerName
              )}

              <br>

              <strong>Email:</strong>
              ${escapeHtml(
                customerEmail
              )}

              <br>

              <strong>
                Delivery address:
              </strong>

              ${escapeHtml(
                formatAddress(
                  shippingAddress
                )
              )}

            </p>


            <h2>
              Order
            </h2>


            <table
              style="
                width:100%;
                border-collapse:
                collapse;
              "
            >

              <thead>

                <tr>

                  <th
                    align="left"
                    style="
                      padding:10px;
                      border-bottom:
                      2px solid #222;
                    "
                  >
                    Item
                  </th>


                  <th
                    style="
                      padding:10px;
                      border-bottom:
                      2px solid #222;
                    "
                  >
                    Qty
                  </th>


                  <th
                    align="left"
                    style="
                      padding:10px;
                      border-bottom:
                      2px solid #222;
                    "
                  >
                    Model file
                  </th>

                </tr>

              </thead>


              <tbody>

                ${orderRows}

              </tbody>

            </table>


            <p
              style="
                margin-top:15px;
                color:#666;
                font-size:12px;
              "
            >

              Model download links are
              private temporary links and
              expire after 7 days.

            </p>


            <p
              style="
                margin-top:20px;
                font-size:18px;
              "
            >

              <strong>
                Amount paid:
              </strong>

              ${formatMoney(
                fullSession
                  .amount_total
              )}

            </p>


            <p>

              <strong>
                Stripe session:
              </strong>

              ${escapeHtml(
                orderReference
              )}

              <br>

              <strong>
                Payment reference:
              </strong>

              ${escapeHtml(
                paymentReference
              )}

            </p>


            <p
              style="
                color:#666;
                font-size:12px;
              "
            >

              This order email was sent
              automatically after Stripe
              confirmed payment.

            </p>

          </div>
        `;


        await sendResendEmail({

          from:
            "Layer3DPost Orders <orders@layer3dpost.co.uk>",

          to: [
            "Layer3dpost@outlook.com"
          ],

          subject:
            "New Layer3DPost order - " +
            orderReference,

          html:
            adminEmailHtml,

          replyTo:
            customerEmail ||
            "Layer3dpost@outlook.com",

          idempotencyKey:
            "admin-order-" +
            orderReference
        });


        /* =====================================================
           CUSTOMER CONFIRMATION

           NOTE:
           CUSTOMER DOES NOT RECEIVE
           THE PRIVATE MODEL DOWNLOAD URL.
        ===================================================== */

        if (customerEmail) {

          const customerHtml = `

            <div
              style="
                font-family:
                Arial,
                Helvetica,
                sans-serif;
                color:#222;
                max-width:650px;
                margin:auto;
              "
            >

              <h1>
                Thank you for your order
              </h1>


              <p>

                Hi
                ${escapeHtml(
                  customerName
                )},

              </p>


              <p>

                We've received your
                Layer3DPost order and
                Stripe has confirmed
                your payment.

              </p>


              <p>

                <strong>
                  Order reference:
                </strong>

                ${escapeHtml(
                  orderReference
                )}

              </p>


              <p>

                <strong>
                  Amount paid:
                </strong>

                ${formatMoney(
                  fullSession
                    .amount_total
                )}

              </p>


              <p>

                <strong>
                  Delivery address:
                </strong>

                <br>

                ${escapeHtml(
                  formatAddress(
                    shippingAddress
                  )
                )}

              </p>


              <p>

                We'll prepare your
                3D print and contact
                you if we need any
                additional information.

              </p>


              <p>

                Layer3DPost
                <br>
                CJ FX Limited

              </p>

            </div>
          `;


          await sendResendEmail({

            from:
              "Layer3DPost <orders@layer3dpost.co.uk>",

            to: [
              customerEmail
            ],

            subject:
              "Layer3DPost order confirmation",

            html:
              customerHtml,

            replyTo:
              "Layer3dpost@outlook.com",

            idempotencyKey:
              "customer-order-" +
              orderReference
          });
        }


        console.log(
          "Order emails sent for:",
          orderReference
        );
      }


      res.json({
        received: true
      });

    }

    catch (error) {

      console.error(
        "Webhook processing error:",
        error
      );


      /*
        Returning 500 allows Stripe
        to retry the webhook.
      */

      res.status(500).json({

        received: false,

        error:
          "Webhook processing failed."
      });
    }
  }
);


/* =========================================================
   NORMAL EXPRESS BODY PARSING

   MUST BE AFTER STRIPE WEBHOOK
========================================================= */

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);


/* =========================================================
   STATIC WEBSITE
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================================================
   MODEL UPLOAD

   Files are temporarily received by Render,
   uploaded to private Cloudflare R2,
   then immediately deleted from Render.
========================================================= */

const upload =
  multer({

    dest:
      "/tmp/layer3dpost/",

    limits: {

      fileSize:
        100 *
        1024 *
        1024
    },

    fileFilter:
      function (
        req,
        file,
        cb
      ) {

        const name =
          file
            .originalname
            .toLowerCase();


        if (
          name.endsWith(".stl") ||
          name.endsWith(".3mf")
        ) {

          cb(
            null,
            true
          );

        }

        else {

          cb(
            new Error(
              "Only STL and 3MF files are accepted."
            )
          );
        }
      }
  });


app.post(
  "/api/upload",

  upload.single("model"),

  async function (
    req,
    res,
    next
  ) {

    if (!req.file) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            "No model file uploaded."
        });
    }


    try {

      const objectKey =
        await uploadFileToR2(
          req.file
        );


      console.log(
        "Model stored in R2:",
        objectKey
      );


      res.json({

        success: true,

        filename:
          req.file.originalname,

        uploadId:
          objectKey
      });

    }

    catch (error) {

      /*
        Make sure a failed R2 upload
        does not leave a temporary
        file behind on Render.
      */

      try {

        if (
          req.file &&
          req.file.path &&
          fs.existsSync(
            req.file.path
          )
        ) {

          fs.unlinkSync(
            req.file.path
          );
        }

      }

      catch (cleanupError) {

        console.error(
          "Upload cleanup error:",
          cleanupError
        );
      }


      console.error(
        "R2 upload error:",
        error
      );


      next(
        new Error(
          "Unable to store the model file. Please try again."
        )
      );
    }
  }
);


/* =========================================================
   CREATE STRIPE CHECKOUT SESSION
========================================================= */

app.post(
  "/api/create-checkout-session",

  async function (
    req,
    res
  ) {

    try {

      const stripe =
        getStripe();


      const basket =
        req.body.basket;


      if (
        !Array.isArray(
          basket
        ) ||
        basket.length === 0
      ) {

        return res
          .status(400)
          .json({

            error:
              "Basket is empty."
          });
      }


      if (
        basket.length > 20
      ) {

        return res
          .status(400)
          .json({

            error:
              "Basket contains too many items."
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


      const basePrice =
        9.95;


      const lineItems = [];

      const metadata = {

        item_count:
          String(
            basket.length
          )
      };


      /*
        Check that every model really
        exists in private R2 before
        allowing payment.
      */

      for (
        let index = 0;
        index < basket.length;
        index++
      ) {

        const item =
          basket[index];


        const materialMultiplier =
          materialMultipliers[
            item.material
          ];


        const qualityMultiplier =
          qualityMultipliers[
            item.quality
          ];


        if (
          !materialMultiplier ||
          !qualityMultiplier
        ) {

          throw new Error(
            "Invalid print configuration."
          );
        }


        const uploadId =
          String(
            item.uploadId || ""
          );


        if (
          !uploadId.startsWith(
            "uploads/"
          )
        ) {

          throw new Error(
            "One of the model uploads is invalid. Please upload the model again."
          );
        }


        const exists =
          await r2ObjectExists(
            uploadId
          );


        if (!exists) {

          throw new Error(
            "One of the model files could not be found. Please upload it again before checkout."
          );
        }


        const quantity =
          Math.max(

            1,

            Math.min(

              100,

              Number(
                item.quantity
              ) || 1
            )
          );


        const unitPrice =

          basePrice *

          materialMultiplier *

          qualityMultiplier;


        lineItems.push({

          price_data: {

            currency:
              "gbp",

            product_data: {

              name:
                String(
                  item.filename ||
                  "3D Print"
                ),

              description:

                String(
                  item.material
                )

                +

                " · "

                +

                String(
                  item.colour
                )

                +

                " · "

                +

                String(
                  item.quality
                )
            },

            unit_amount:
              Math.round(
                unitPrice * 100
              )
          },

          quantity:
            quantity
        });


        /*
          Stripe metadata tells the
          webhook which private R2
          object belongs to the order.
        */

        const orderItem = {

          filename:
            String(
              item.filename ||
              ""
            )
              .slice(
                0,
                120
              ),

          uploadId:
            uploadId
              .slice(
                0,
                160
              ),

          material:
            String(
              item.material ||
              ""
            )
              .slice(
                0,
                40
              ),

          colour:
            String(
              item.colour ||
              ""
            )
              .slice(
                0,
                80
              ),

          quality:
            String(
              item.quality ||
              ""
            )
              .slice(
                0,
                40
              ),

          quantity:
            quantity
        };


        metadata[
          "item_" + index
        ] =
          JSON.stringify(
            orderItem
          );
      }


      /* =====================================================
         UK TRACKED DELIVERY
      ===================================================== */

      lineItems.push({

        price_data: {

          currency:
            "gbp",

          product_data: {

            name:
              "UK Tracked Delivery"
          },

          unit_amount:
            449
        },

        quantity:
          1
      });


      const baseUrl =

        req.protocol

        +

        "://"

        +

        req.get("host");


      const session =
        await stripe
          .checkout
          .sessions
          .create({

            mode:
              "payment",

            line_items:
              lineItems,

            metadata:
              metadata,

            success_url:

              baseUrl

              +

              "/?payment=success",

            cancel_url:

              baseUrl

              +

              "/?payment=cancelled",

            billing_address_collection:
              "required",

            shipping_address_collection: {

              allowed_countries: [
                "GB"
              ]
            },

            customer_creation:
              "always"
          });


      res.json({

        url:
          session.url
      });

    }

    catch (error) {

      console.error(
        "Stripe checkout error:",
        error
      );


      res
        .status(500)
        .json({

          error:

            error.message

            ||

            "Unable to create checkout."
        });
    }
  }
);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",

  function (
    req,
    res
  ) {

    res.json({

      status:
        "ok",

      service:
        "Layer3DPost",

      storage:
        "Cloudflare R2"
    });
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  function (
    err,
    req,
    res,
    next
  ) {

    console.error(
      err
    );


    res
      .status(400)
      .json({

        success:
          false,

        error:
          err.message
      });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",

  function () {

    console.log(
      "Layer3DPost running on port " +
      PORT
    );
  }
);