const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const Stripe = require("stripe");
const AdmZip = require("adm-zip");

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


async function uploadFileToR2(file, analysis) {

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
            ),

          modelxmm:
            String(analysis.xMm),

          modelymm:
            String(analysis.yMm),

          modelzmm:
            String(analysis.zMm),

          modelvolumecm3:
            String(analysis.volumeCm3),

          modeltriangles:
            String(analysis.triangleCount)
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


/* =========================================================
   STAGE 2 AUTOMATIC PRICING

   Pricing is calculated from geometry stored
   securely in private R2 metadata.

   The browser does NOT decide the Stripe price.
========================================================= */

function getSizeCharge(longestDimensionMm) {

  if (longestDimensionMm <= 50) {
    return 0;
  }

  if (longestDimensionMm <= 100) {
    return 2;
  }

  if (longestDimensionMm <= 150) {
    return 5;
  }

  if (longestDimensionMm <= 200) {
    return 9;
  }

  return 15;
}


function calculateModelPrice(
  analysis,
  material,
  quality
) {

  const materialMultipliers = {

    PLA:
      1,

    PETG:
      1.25,

    TPU:
      1.45,

    "PLA-CF":
      1.6
  };


  const qualityMultipliers = {

    Standard:
      1,

    Fine:
      1.25,

    "High detail":
      1.5
  };


  const materialMultiplier =
    materialMultipliers[
      material
    ];


  const qualityMultiplier =
    qualityMultipliers[
      quality
    ];


  if (
    !materialMultiplier ||
    !qualityMultiplier
  ) {

    throw new Error(
      "Invalid print configuration."
    );
  }


  const longestDimensionMm =
    Math.max(
      analysis.xMm,
      analysis.yMm,
      analysis.zMm
    );


  const sizeCharge =
    getSizeCharge(
      longestDimensionMm
    );


  /*
    £0.45 per cm³ of verified
    model mesh volume.
  */

  const volumeCharge =
    analysis.volumeCm3 *
    0.45;


  /*
    Standard PLA calculation:

    £4.50 setup
    + volume charge
    + size charge

    £9.95 minimum.
  */

  const standardPlaPrice =
    Math.max(

      9.95,

      4.50 +
      volumeCharge +
      sizeCharge
    );


  /*
    Apply the customer's selected
    material and print quality.

    Round to pennies before sending
    the amount to Stripe.
  */

  const unitPrice =
    Number(
      (
        standardPlaPrice *
        materialMultiplier *
        qualityMultiplier
      ).toFixed(2)
    );


  return {

    unitPrice:
      unitPrice,

    standardPlaPrice:
      Number(
        standardPlaPrice.toFixed(2)
      ),

    volumeCharge:
      Number(
        volumeCharge.toFixed(2)
      ),

    sizeCharge:
      sizeCharge,

    longestDimensionMm:
      Number(
        longestDimensionMm.toFixed(3)
      )
  };
}


async function getVerifiedModelAnalysisFromR2(
  objectKey
) {

  if (
    !objectKey ||
    !String(objectKey)
      .startsWith(
        "uploads/"
      )
  ) {

    throw new Error(
      "One of the model uploads is invalid. Please upload the model again."
    );
  }


  let response;


  try {

    response =
      await getR2().send(

        new HeadObjectCommand({

          Bucket:
            process.env.R2_BUCKET_NAME,

          Key:
            objectKey
        })
      );

  }

  catch (error) {

    console.error(
      "R2 model metadata check failed:",
      objectKey,
      error.name || error.message
    );


    throw new Error(
      "One of the model files could not be found. Please upload it again before checkout."
    );
  }


  /*
    These measurements were generated by
    our server when the STL/3MF was uploaded.

    They are read from R2 rather than
    accepted from the customer's browser.
  */

  const metadata =
    response.Metadata || {};


  const analysis = {

    xMm:
      Number(
        metadata.modelxmm
      ),

    yMm:
      Number(
        metadata.modelymm
      ),

    zMm:
      Number(
        metadata.modelzmm
      ),

    volumeCm3:
      Number(
        metadata.modelvolumecm3
      ),

    triangleCount:
      Number(
        metadata.modeltriangles || 0
      )
  };


  const validDimensions =

    Number.isFinite(
      analysis.xMm
    ) &&

    analysis.xMm > 0 &&

    Number.isFinite(
      analysis.yMm
    ) &&

    analysis.yMm > 0 &&

    Number.isFinite(
      analysis.zMm
    ) &&

    analysis.zMm > 0 &&

    analysis.xMm <=
      MAX_MODEL_DIMENSION_MM &&

    analysis.yMm <=
      MAX_MODEL_DIMENSION_MM &&

    analysis.zMm <=
      MAX_MODEL_DIMENSION_MM;


  /*
    Automatic pricing requires a
    positive measurable model volume.

    Older uploads without Stage 1
    geometry metadata will therefore
    be rejected and must be uploaded
    again.
  */

  const validVolume =

    Number.isFinite(
      analysis.volumeCm3
    ) &&

    analysis.volumeCm3 > 0;


  if (
    !validDimensions ||
    !validVolume
  ) {

    throw new Error(
      "This model does not contain valid automatic-pricing data. Please upload the model again."
    );
  }


  return analysis;
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
   MODEL ANALYSIS

   - measures uploaded STL / 3MF files
   - rejects models larger than 256 mm on any axis
   - stores verified geometry for automatic pricing
========================================================= */

const MAX_MODEL_DIMENSION_MM = 256;


function finishModelAnalysis(
  min,
  max,
  signedVolumeMm3,
  triangleCount
) {

  if (
    !Number.isFinite(min.x) ||
    !Number.isFinite(min.y) ||
    !Number.isFinite(min.z) ||
    !Number.isFinite(max.x) ||
    !Number.isFinite(max.y) ||
    !Number.isFinite(max.z) ||
    triangleCount < 1
  ) {

    throw new Error(
      "The model does not contain readable mesh geometry."
    );
  }


  const xMm =
    max.x - min.x;

  const yMm =
    max.y - min.y;

  const zMm =
    max.z - min.z;


  if (
    xMm <= 0 ||
    yMm <= 0 ||
    zMm <= 0
  ) {

    throw new Error(
      "The model has invalid or zero-size dimensions."
    );
  }


  if (
    xMm > MAX_MODEL_DIMENSION_MM ||
    yMm > MAX_MODEL_DIMENSION_MM ||
    zMm > MAX_MODEL_DIMENSION_MM
  ) {

    throw new Error(
      "This model is too large. Maximum supported size is 256 × 256 × 256 mm. " +
      "Detected size: " +
      xMm.toFixed(1) +
      " × " +
      yMm.toFixed(1) +
      " × " +
      zMm.toFixed(1) +
      " mm."
    );
  }


  return {

    xMm:
      Number(
        xMm.toFixed(3)
      ),

    yMm:
      Number(
        yMm.toFixed(3)
      ),

    zMm:
      Number(
        zMm.toFixed(3)
      ),

    volumeCm3:
      Number(
        (
          Math.abs(
            signedVolumeMm3
          ) / 1000
        ).toFixed(3)
      ),

    triangleCount:
      triangleCount
  };
}


function addTriangleToAnalysis(
  state,
  a,
  b,
  c
) {

  for (
    const point of [
      a,
      b,
      c
    ]
  ) {

    state.min.x =
      Math.min(
        state.min.x,
        point.x
      );

    state.min.y =
      Math.min(
        state.min.y,
        point.y
      );

    state.min.z =
      Math.min(
        state.min.z,
        point.z
      );

    state.max.x =
      Math.max(
        state.max.x,
        point.x
      );

    state.max.y =
      Math.max(
        state.max.y,
        point.y
      );

    state.max.z =
      Math.max(
        state.max.z,
        point.z
      );
  }


  state.signedVolumeMm3 +=
    (
      a.x *
      (
        b.y * c.z -
        b.z * c.y
      )

      -

      a.y *
      (
        b.x * c.z -
        b.z * c.x
      )

      +

      a.z *
      (
        b.x * c.y -
        b.y * c.x
      )

    ) / 6;


  state.triangleCount++;
}


function newAnalysisState() {

  return {

    min: {
      x: Infinity,
      y: Infinity,
      z: Infinity
    },

    max: {
      x: -Infinity,
      y: -Infinity,
      z: -Infinity
    },

    signedVolumeMm3:
      0,

    triangleCount:
      0
  };
}


function analyseBinaryStl(buffer) {

  if (
    buffer.length < 84
  ) {

    throw new Error(
      "The STL file is incomplete or invalid."
    );
  }


  const triangleCount =
    buffer.readUInt32LE(80);

  const expectedLength =
    84 +
    triangleCount * 50;


  if (
    triangleCount < 1 ||
    expectedLength >
      buffer.length
  ) {

    throw new Error(
      "The STL file is incomplete or invalid."
    );
  }


  const state =
    newAnalysisState();


  for (
    let i = 0;
    i < triangleCount;
    i++
  ) {

    const offset =
      84 +
      i * 50 +
      12;


    const a = {

      x:
        buffer.readFloatLE(
          offset
        ),

      y:
        buffer.readFloatLE(
          offset + 4
        ),

      z:
        buffer.readFloatLE(
          offset + 8
        )
    };


    const b = {

      x:
        buffer.readFloatLE(
          offset + 12
        ),

      y:
        buffer.readFloatLE(
          offset + 16
        ),

      z:
        buffer.readFloatLE(
          offset + 20
        )
    };


    const c = {

      x:
        buffer.readFloatLE(
          offset + 24
        ),

      y:
        buffer.readFloatLE(
          offset + 28
        ),

      z:
        buffer.readFloatLE(
          offset + 32
        )
    };


    addTriangleToAnalysis(
      state,
      a,
      b,
      c
    );
  }


  return finishModelAnalysis(
    state.min,
    state.max,
    state.signedVolumeMm3,
    state.triangleCount
  );
}


function analyseAsciiStl(buffer) {

  const text =
    buffer.toString(
      "utf8"
    );


  const vertexRegex =
    /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/gi;


  const vertices = [];

  let match;


  while (
    (
      match =
        vertexRegex.exec(
          text
        )
    ) !== null
  ) {

    vertices.push({

      x:
        Number(
          match[1]
        ),

      y:
        Number(
          match[2]
        ),

      z:
        Number(
          match[3]
        )
    });
  }


  if (
    vertices.length < 3 ||
    vertices.length % 3 !== 0
  ) {

    throw new Error(
      "The ASCII STL file does not contain valid triangles."
    );
  }


  const state =
    newAnalysisState();


  for (
    let i = 0;
    i < vertices.length;
    i += 3
  ) {

    addTriangleToAnalysis(

      state,

      vertices[i],

      vertices[
        i + 1
      ],

      vertices[
        i + 2
      ]
    );
  }


  return finishModelAnalysis(
    state.min,
    state.max,
    state.signedVolumeMm3,
    state.triangleCount
  );
}


function analyseStl(filePath) {

  const buffer =
    fs.readFileSync(
      filePath
    );


  if (
    buffer.length >= 84
  ) {

    const triangleCount =
      buffer.readUInt32LE(
        80
      );

    const expectedLength =
      84 +
      triangleCount * 50;


    if (
      triangleCount > 0 &&
      expectedLength ===
        buffer.length
    ) {

      return analyseBinaryStl(
        buffer
      );
    }
  }


  return analyseAsciiStl(
    buffer
  );
}


function getXmlAttribute(
  tag,
  name
) {

  const regex =
    new RegExp(
      `${name}\\s*=\\s*["\']([^"\']+)["\']`,
      "i"
    );


  const match =
    regex.exec(
      tag
    );


  return match
    ? match[1]
    : null;
}
function analyse3mf(filePath) {

  const zip =
    new AdmZip(
      filePath
    );


  const entries =
    zip.getEntries();


  const modelEntries =
    entries.filter(
      function (entry) {

        return (
          !entry.isDirectory &&
          /(^|\/)3d\/.*\.model$/i
            .test(
              entry.entryName
            )
        );
      }
    );


  if (
    modelEntries.length === 0
  ) {

    throw new Error(
      "The 3MF file does not contain a readable 3D model."
    );
  }


  const state =
    newAnalysisState();


  for (
    const entry of
      modelEntries
  ) {

    const xml =
      entry
        .getData()
        .toString(
          "utf8"
        );


    const modelTagMatch =
      xml.match(
        /<model\b[^>]*>/i
      );


    const unit =
      modelTagMatch

        ?

        (
          getXmlAttribute(
            modelTagMatch[0],
            "unit"
          ) ||
          "millimeter"
        ).toLowerCase()

        :

        "millimeter";


    const unitToMm = {

      micron:
        0.001,

      millimeter:
        1,

      centimeter:
        10,

      inch:
        25.4,

      foot:
        304.8,

      meter:
        1000

    }[unit];


    if (!unitToMm) {

      throw new Error(
        "This 3MF file uses an unsupported measurement unit."
      );
    }


    const objectRegex =
      /<object\b[^>]*>[\s\S]*?<\/object>/gi;


    let objectMatch;


    while (
      (
        objectMatch =
          objectRegex.exec(
            xml
          )
      ) !== null
    ) {

      const objectXml =
        objectMatch[0];


      if (
        !/<mesh\b/i.test(
          objectXml
        )
      ) {

        continue;
      }


      const vertices = [];


      const vertexRegex =
        /<vertex\b[^>]*\/?\s*>/gi;


      let vertexMatch;


      while (
        (
          vertexMatch =
            vertexRegex.exec(
              objectXml
            )
        ) !== null
      ) {

        const tag =
          vertexMatch[0];


        const x =
          Number(
            getXmlAttribute(
              tag,
              "x"
            )
          );


        const y =
          Number(
            getXmlAttribute(
              tag,
              "y"
            )
          );


        const z =
          Number(
            getXmlAttribute(
              tag,
              "z"
            )
          );


        if (
          ![
            x,
            y,
            z
          ].every(
            Number.isFinite
          )
        ) {

          throw new Error(
            "The 3MF file contains an invalid vertex."
          );
        }


        vertices.push({

          x:
            x *
            unitToMm,

          y:
            y *
            unitToMm,

          z:
            z *
            unitToMm
        });
      }


      const triangleRegex =
        /<triangle\b[^>]*\/?\s*>/gi;


      let triangleMatch;


      while (
        (
          triangleMatch =
            triangleRegex.exec(
              objectXml
            )
        ) !== null
      ) {

        const tag =
          triangleMatch[0];


        const v1 =
          Number(
            getXmlAttribute(
              tag,
              "v1"
            )
          );


        const v2 =
          Number(
            getXmlAttribute(
              tag,
              "v2"
            )
          );


        const v3 =
          Number(
            getXmlAttribute(
              tag,
              "v3"
            )
          );


        if (
          !Number.isInteger(
            v1
          ) ||
          !Number.isInteger(
            v2
          ) ||
          !Number.isInteger(
            v3
          ) ||
          !vertices[v1] ||
          !vertices[v2] ||
          !vertices[v3]
        ) {

          throw new Error(
            "The 3MF file contains an invalid triangle."
          );
        }


        addTriangleToAnalysis(

          state,

          vertices[v1],

          vertices[v2],

          vertices[v3]
        );
      }
    }
  }


  return finishModelAnalysis(
    state.min,
    state.max,
    state.signedVolumeMm3,
    state.triangleCount
  );
}


function analyseModelFile(
  file
) {

  const extension =
    path
      .extname(
        file.originalname ||
        ""
      )
      .toLowerCase();


  if (
    extension === ".stl"
  ) {

    return analyseStl(
      file.path
    );
  }


  if (
    extension === ".3mf"
  ) {

    return analyse3mf(
      file.path
    );
  }


  throw new Error(
    "Only STL and 3MF files are accepted."
  );
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

   Files are temporarily received by Render.

   Before the file is copied to R2:
   1. STL / 3MF geometry is analysed.
   2. Dimensions and mesh volume are calculated.
   3. Oversize models are rejected.
   4. Verified measurements are stored in R2 metadata.

   The temporary Render file is then deleted.
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

      /*
        Analyse the temporary file BEFORE
        uploadFileToR2 deletes that copy.
      */

      const analysis =
        analyseModelFile(
          req.file
        );


      console.log(
        "Model analysis:",
        req.file.originalname,
        analysis
      );


      const objectKey =
        await uploadFileToR2(
          req.file,
          analysis
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
          objectKey,

        analysis: {

          dimensions: {

            x:
              analysis.xMm,

            y:
              analysis.yMm,

            z:
              analysis.zMm
          },

          volumeCm3:
            analysis.volumeCm3,

          triangleCount:
            analysis.triangleCount
        }
      });

    }

    catch (error) {

      /*
        If analysis fails before the R2
        upload begins, the temporary file
        still needs to be deleted.

        If R2 upload fails,
        uploadFileToR2 also attempts
        cleanup in its finally block.
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
        "Model upload/analysis error:",
        error
      );


      next(
        new Error(
          error.message ||
          "Unable to analyse or store the model file. Please try again."
        )
      );
    }
  }
);
/* =========================================================
   AUTOMATIC PRICE CALCULATION API

   The browser can ask for a price to DISPLAY,
   but the browser does not supply the geometry
   or decide the final Stripe amount.

   Geometry is retrieved from private R2 metadata.
========================================================= */

app.post(
  "/api/calculate-price",

  async function (
    req,
    res
  ) {

    try {

      const uploadId =
        String(
          req.body.uploadId || ""
        );


      const material =
        String(
          req.body.material || ""
        );


      const quality =
        String(
          req.body.quality || ""
        );


      const requestedQuantity =
        Number(
          req.body.quantity
        );


      if (
        !Number.isInteger(
          requestedQuantity
        ) ||
        requestedQuantity < 1 ||
        requestedQuantity > 100
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Quantity must be between 1 and 100."
          });
      }


      /*
        Retrieve the measurements our server
        stored when the model was uploaded.

        We deliberately ignore any dimensions,
        volume or price supplied by the browser.
      */

      const analysis =
        await getVerifiedModelAnalysisFromR2(
          uploadId
        );


      const pricing =
        calculateModelPrice(
          analysis,
          material,
          quality
        );


      const printPrice =
        Number(
          (
            pricing.unitPrice *
            requestedQuantity
          ).toFixed(2)
        );


      res.json({

        success:
          true,

        currency:
          "GBP",

        unitPrice:
          pricing.unitPrice,

        quantity:
          requestedQuantity,

        printPrice:
          printPrice,

        standardPlaPrice:
          pricing.standardPlaPrice,

        pricing: {

          setupCharge:
            4.50,

          minimumPrice:
            9.95,

          volumeRatePerCm3:
            0.45,

          volumeCharge:
            pricing.volumeCharge,

          sizeCharge:
            pricing.sizeCharge,

          longestDimensionMm:
            pricing.longestDimensionMm
        },

        analysis: {

          dimensions: {

            x:
              analysis.xMm,

            y:
              analysis.yMm,

            z:
              analysis.zMm
          },

          volumeCm3:
            analysis.volumeCm3,

          triangleCount:
            analysis.triangleCount
        }
      });

    }

    catch (error) {

      console.error(
        "Automatic price calculation error:",
        error
      );


      res
        .status(400)
        .json({

          success:
            false,

          error:

            error.message

            ||

            "Unable to calculate the model price."
        });
    }
  }
);


/* =========================================================
   CREATE STRIPE CHECKOUT SESSION

   STAGE 2:
   The final Stripe price is calculated here
   from verified geometry stored in R2.

   The customer's browser cannot choose or
   alter the price sent to Stripe.
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


      const lineItems = [];


      const metadata = {

        item_count:
          String(
            basket.length
          )
      };


      /*
        Every basket item is independently
        checked against private R2.

        The measurements used for pricing
        are therefore the measurements
        generated by our own upload analyser.
      */

      for (
        let index = 0;
        index < basket.length;
        index++
      ) {

        const item =
          basket[index];


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


        /*
          Get verified dimensions and volume.

          This also proves that the R2
          object exists.
        */

        const analysis =
          await getVerifiedModelAnalysisFromR2(
            uploadId
          );


        const quantityValue =
          Number(
            item.quantity
          );


        if (
          !Number.isInteger(
            quantityValue
          ) ||
          quantityValue < 1 ||
          quantityValue > 100
        ) {

          throw new Error(
            "Invalid print quantity."
          );
        }


        const quantity =
          quantityValue;


        const material =
          String(
            item.material || ""
          );


        const quality =
          String(
            item.quality || ""
          );


        /*
          SERVER-AUTHORITATIVE PRICE

          The browser price is ignored.

          calculateModelPrice() uses:
          - verified mesh volume
          - verified longest dimension
          - material
          - quality
        */

        const pricing =
          calculateModelPrice(
            analysis,
            material,
            quality
          );


        const unitPrice =
          pricing.unitPrice;


        console.log(
          "Verified checkout pricing:",
          {
            uploadId:
              uploadId,

            dimensions:
              {
                x:
                  analysis.xMm,

                y:
                  analysis.yMm,

                z:
                  analysis.zMm
              },

            volumeCm3:
              analysis.volumeCm3,

            material:
              material,

            quality:
              quality,

            standardPlaPrice:
              pricing.standardPlaPrice,

            unitPrice:
              unitPrice,

            quantity:
              quantity
          }
        );


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

                material

                +

                " · "

                +

                String(
                  item.colour || ""
                )

                +

                " · "

                +

                quality
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
          Stripe metadata tells the webhook
          which private R2 object belongs
          to the paid order.

          The calculated unit price and
          geometry are also recorded for
          useful order reference information.
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
            material
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
            quality
              .slice(
                0,
                40
              ),

          quantity:
            quantity,

          unitPrice:
            unitPrice,

          xMm:
            analysis.xMm,

          yMm:
            analysis.yMm,

          zMm:
            analysis.zMm,

          volumeCm3:
            analysis.volumeCm3
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

         Added once per complete order.
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
        "Cloudflare R2",

      modelAnalysis:
        "enabled",

      automaticPricing:
        "enabled",

      pricingVersion:
        "stage-2-v1",

      minimumPrintPrice:
        9.95,

      volumeRatePerCm3:
        0.45,

      maxModelDimensionMm:
        MAX_MODEL_DIMENSION_MM
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