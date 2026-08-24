let cachedToken = null;
let cachedTokenExpiresAt = 0;

export default async function handler(req, res) {
  // Allow requests only from The Highland Mint storefront
  const allowedOrigins = [
    "https://www.highlandmint.com",
    "https://highlandmint.com"
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Browser CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(400).json({
      error: "Email is required"
    });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "Please enter a valid email address."
    });
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    console.error("Missing Shopify environment variables");

    return res.status(500).json({
      error: "Server configuration is incomplete."
    });
  }

  try {
    // ---------------------------------------------------
    // 1. Authenticate with Shopify
    // ---------------------------------------------------

    const token = await getShopifyAccessToken(
      shop,
      clientId,
      clientSecret
    );

    // ---------------------------------------------------
    // 2. Find Shopify customer
    // ---------------------------------------------------

    const customerQuery = `
      query FindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
            numberOfOrders
          }
        }
      }
    `;

    const customerResponse = await shopifyGraphQL(
      shop,
      token,
      customerQuery,
      {
        query: `email:${email}`
      }
    );

    const customer =
      customerResponse?.data?.customers?.nodes?.[0];

    if (!customer) {
      return res.status(404).json({
        error:
          "We could not find a customer account with that email."
      });
    }

    // Extra safety:
    // Ensure Shopify returned the exact email requested.
    if (
      String(customer.email || "").toLowerCase() !== email
    ) {
      return res.status(404).json({
        error:
          "We could not find a customer account with that email."
      });
    }

    // ---------------------------------------------------
    // 3. Verify previous purchase
    // ---------------------------------------------------

    if (Number(customer.numberOfOrders || 0) < 1) {
      return res.status(403).json({
        error:
          "This offer is available to existing customers with a previous order."
      });
    }

    // ---------------------------------------------------
    // 4. Create a permanent identifier for this customer
    // ---------------------------------------------------

    // Example customer ID:
    // gid://shopify/Customer/123456789

    const customerNumericId =
      customer.id.split("/").pop();

    const offerTitle =
      `Pamphlet 5% Offer - Customer ${customerNumericId}`;

    // ---------------------------------------------------
    // 5. Check whether customer already activated
    // ---------------------------------------------------

    const existingDiscountQuery = `
      query ExistingPamphletDiscount($query: String!) {
        codeDiscountNodes(
          first: 10
          query: $query
        ) {
          nodes {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                startsAt
                endsAt
                status
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
        }
      }
    `;

    const existingResponse = await shopifyGraphQL(
      shop,
      token,
      existingDiscountQuery,
      {
        query: `title:"${offerTitle}"`
      }
    );

    const existingNodes =
      existingResponse?.data?.codeDiscountNodes?.nodes ||
      [];

    const existingDiscount = existingNodes.find(
      (node) =>
        node?.codeDiscount?.title === offerTitle
    )?.codeDiscount;

    // ---------------------------------------------------
    // 6. Customer already activated this offer
    // ---------------------------------------------------

    if (existingDiscount) {
      const existingCode =
        existingDiscount.codes?.nodes?.[0]?.code;

      return res.status(200).json({
        success: true,
        alreadyActivated: true,
        code: existingCode || null,
        expiresAt: existingDiscount.endsAt,
        message:
          "You have already activated this offer."
      });
    }

    // ---------------------------------------------------
    // 7. Start the 15-day period NOW
    // ---------------------------------------------------

    const startsAt = new Date();

    const endsAt = new Date(
      startsAt.getTime() +
        15 * 24 * 60 * 60 * 1000
    );

    // ---------------------------------------------------
    // 8. Generate unique discount code
    // ---------------------------------------------------

    const randomPart = crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 8)
      .toUpperCase();

    const discountCode =
      `HM5-${randomPart}`;

    // ---------------------------------------------------
    // 9. Create the Shopify discount
    // ---------------------------------------------------

    const createDiscountMutation = `
      mutation CreateDiscount(
        $basicCodeDiscount: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(
          basicCodeDiscount: $basicCodeDiscount
        ) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                startsAt
                endsAt
                status
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }

          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      basicCodeDiscount: {
        title: offerTitle,

        code: discountCode,

        startsAt: startsAt.toISOString(),

        endsAt: endsAt.toISOString(),

        customerSelection: {
          customers: {
            add: [customer.id]
          }
        },

        customerGets: {
          value: {
            percentage: 0.05
          },

          items: {
            all: true
          }
        },

        usageLimit: 1,

        appliesOncePerCustomer: true
      }
    };

    const discountResponse = await shopifyGraphQL(
      shop,
      token,
      createDiscountMutation,
      variables
    );

    const result =
      discountResponse?.data?.discountCodeBasicCreate;

    // ---------------------------------------------------
    // 10. Handle Shopify errors
    // ---------------------------------------------------

    if (result?.userErrors?.length) {
      console.error(
        "Discount creation error:",
        result.userErrors
      );

      return res.status(400).json({
        error:
          result.userErrors[0]?.message ||
          "Unable to create discount."
      });
    }

    if (!result?.codeDiscountNode) {
      throw new Error(
        "Shopify did not create the discount."
      );
    }

    // ---------------------------------------------------
    // 11. Return successful activation
    // ---------------------------------------------------

    return res.status(200).json({
      success: true,
      alreadyActivated: false,
      code: discountCode,
      expiresAt: endsAt.toISOString(),
      message:
        "Your 5% offer has been activated."
    });
  } catch (error) {
    console.error(
      "Activation error:",
      error
    );

    return res.status(500).json({
      error:
        "Something went wrong while activating your offer. Please try again."
    });
  }
}


// ======================================================
// SHOPIFY AUTHENTICATION
// ======================================================

async function getShopifyAccessToken(
  shop,
  clientId,
  clientSecret
) {
  const now = Date.now();

  // Reuse token while it is still valid.
  if (
    cachedToken &&
    cachedTokenExpiresAt &&
    now <
      cachedTokenExpiresAt -
        5 * 60 * 1000
  ) {
    return cachedToken;
  }

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type:
          "client_credentials",

        client_id:
          clientId,

        client_secret:
          clientSecret
      })
    }
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    console.error(
      "Shopify authentication failed:",
      data
    );

    throw new Error(
      "Unable to authenticate with Shopify."
    );
  }

  cachedToken =
    data.access_token;

  const expiresInSeconds =
    Number(data.expires_in) ||
    86399;

  cachedTokenExpiresAt =
    Date.now() +
    expiresInSeconds * 1000;

  return cachedToken;
}


// ======================================================
// SHOPIFY GRAPHQL HELPER
// ======================================================

async function shopifyGraphQL(
  shop,
  token,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${shop}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Shopify-Access-Token":
          token
      },

      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.errors
  ) {
    console.error(
      "Shopify GraphQL error:",
      JSON.stringify(
        data,
        null,
        2
      )
    );

    throw new Error(
      "Shopify API request failed."
    );
  }

  return data;
}
