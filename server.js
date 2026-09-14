const express = require("express");

const path = require("path");

const multer = require("multer");

const Stripe = require("stripe");

const app = express();

const PORT =

  process.env.PORT || 3000;

/* =========================================================

   HELPERS

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

   RESEND EMAIL FUNCTION

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

   THIS MUST COME BEFORE express.json()

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

          Some payment methods can complete

          checkout before funds are actually paid.

          Only fulfil once Stripe says the

          payment status is "paid".

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

        /*

          Retrieve the session again so we have

          the freshest customer/shipping data.

        */

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

        /*

          Stripe's newer API versions put shipping

          details here:

          collected_information.shipping_details

        */

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

        /*

          Recover order details from Stripe

          session metadata.

        */

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

        /*

          Create HTML order rows.

        */

        let orderRows = "";

        orderItems.forEach(

          function (item) {

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

                  ${escapeHtml(

                    item.uploadId

                  )}

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

        /*

          EMAIL TO YOU

        */

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

                    Upload ID

                  </th>

                </tr>

              </thead>

              <tbody>

                ${orderRows}

              </tbody>

            </table>

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

        /*

          CUSTOMER CONFIRMATION EMAIL

        */

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

        Returning 500 tells Stripe the

        webhook was not processed, so

        Stripe can retry it.

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

   FILE UPLOAD

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

          name.endsWith(

            ".stl"

          )

          ||

          name.endsWith(

            ".3mf"

          )

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

  upload.single(

    "model"

  ),

  function (

    req,

    res

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

    res.json({

      success: true,

      filename:

        req.file.originalname,

      uploadId:

        req.file.filename

    });

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

        )

        ||

        basket.length === 0

      ) {

        return res

          .status(400)

          .json({

            error:

              "Basket is empty."

          });

      }

      /*

        Prevent huge baskets from

        overflowing Stripe metadata.

      */

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

      const materialMultipliers =

        {

          PLA: 1,

          PETG: 1.25,

          TPU: 1.45,

          "PLA-CF": 1.6

        };

      const qualityMultipliers =

        {

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

      basket.forEach(

        function (

          item,

          index

        ) {

          const materialMultiplier =

            materialMultipliers[

              item.material

            ];

          const qualityMultiplier =

            qualityMultipliers[

              item.quality

            ];

          if (

            !materialMultiplier

            ||

            !qualityMultiplier

          ) {

            throw new Error(

              "Invalid print configuration."

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

            Keep a small copy of each

            item in Stripe metadata so

            the webhook can reconstruct

            the order.

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

              String(

                item.uploadId ||

                ""

              )

                .slice(

                  0,

                  120

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

            "item_" +

            index

          ] =

            JSON.stringify(

              orderItem

            );

        }

      );

      /*

        Delivery charge

      */

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

        req.get(

          "host"

        );

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

              allowed_countries:

                [

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

        "Layer3DPost"

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

      "Layer3DPost running on port "

      +

      PORT

    );

  }

);