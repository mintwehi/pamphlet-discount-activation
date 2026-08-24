export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({ error: "Server configuration is incomplete" });
  }

  try {
    // 1. Find customer by email
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

    const customer = customerResponse?.data?.customers?.nodes?.[0];

    if (!customer) {
      return res.status(404).json({
        error: "We could not find a customer account with that email."
      });
    }

    // 2. Require at least one previous order
    if (Number(customer.numberOfOrders || 0) < 1) {
      return res.status(403).json({
        error: "This offer is available to existing customers with a previous order."
      });
    }

    // 3. Create dates
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 15 * 24 * 60 * 60 * 1000);

    // 4. Generate unique discount code
    const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const discountCode = `HM5-${randomPart}`;

    // 5. Create 5% discount restricted to this customer
    const mutation = `
      mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
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

    const result = discountResponse?.data?.discountCodeBasicCreate;

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
      error: "Something went wrong while activating your offer."
    });
  }
}

async function shopifyGraphQL(shop, token, query, variables = {}) {
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
    console.error(data);
    throw new Error("Shopify API request failed");
  }

  return data;
}
