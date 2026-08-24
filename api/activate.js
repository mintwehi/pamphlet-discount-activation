let cachedToken = null;
let cachedTokenExpiresAt = 0;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    return res.status(500).json({
      error: "Server configuration is incomplete"
    });
  }

  try {
    const token = await getShopifyAccessToken(
      shop,
      clientId,
      clientSecret
    );

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
        error: "We could not find a customer account with that email."
      });
    }

    if (Number(customer.numberOfOrders || 0) < 1) {
      return res.status(403).json({
        error:
          "This offer is available to existing customers with a previous order."
      });
    }

    const startsAt = new Date();

    const endsAt = new Date(
      startsAt.getTime() + 15 * 24 * 60 * 60 * 1000
    );

    const randomPart = crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 8)
      .toUpperCase();

    const discountCode = `HM5-${randomPart}`;

    const mutation = `
      mutation CreateDiscount(
        $basicCodeDiscount: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(
          basicCodeDiscount: $basicCodeDiscount
        ) {
          codeDiscountNode {
            id
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
        title: `Pamphlet 5% Offer - ${email}`,
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
      mutation,
      variables
    );

    const result =
      discountResponse?.data?.discountCodeBasicCreate;

    if (result?.userErrors?.length) {
      console.error(result.userErrors);

      return res.status(400).json({
        error: result.userErrors[0].message
      });
    }

    return res.status(200).json({
      success: true,
      code: discountCode,
      expiresAt: endsAt.toISOString()
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Something went wrong while activating your offer."
    });
  }
}

async function getShopifyAccessToken(
  shop,
  clientId,
  clientSecret
) {
  const now = Date.now();

  if (
    cachedToken &&
    cachedTokenExpiresAt &&
    now < cachedTokenExpiresAt - 5 * 60 * 1000
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
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("Shopify authentication failed:", data);
    throw new Error(
      "Unable to authenticate with Shopify"
    );
  }

  cachedToken = data.access_token;

  const expiresInSeconds =
    Number(data.expires_in) || 86400;

  cachedTokenExpiresAt =
    Date.now() + expiresInSeconds * 1000;

  return cachedToken;
}

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
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors) {
    console.error("Shopify GraphQL error:", data);
    throw new Error("Shopify API request failed");
  }

  return data;
}
