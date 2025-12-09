require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const serviceAccount = require("./clubsphere-firebase-admin-sdk.json");
const app = express();
const port = process.env.PORT || 5000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("clubSphere_db");
    const usersCollection = db.collection("users");
    const eventsCollection = db.collection("events");
    const clubsCollection = db.collection("clubs");
    const managerRequestsCollection = db.collection("managerRequests");
    const paymentsCollection = db.collection("payments");
    const membershipsCollection = db.collection("memberships");

    //-------Role Middleware-------\\
    // admin's middleware
    // const verifyADMIN = async (req, res, next) => {
    //   const email = req.tokenEmail;
    //   const user = await usersCollection.findOne({ email });
    //   if (user?.role !== "admin")
    //     return res
    //       .status(403)
    //       .send({ message: "Admin only Actions!", role: user?.role });

    //   next();
    // };

    // Manager's middleware
    // const verifyMANAGER = async (req, res, next) => {
    //   const email = req.tokenEmail;
    //   const user = await usersCollection.findOne({ email });
    //   if (user?.role !== "manager")
    //     return res
    //       .status(403)
    //       .send({ message: "Manager only Actions!", role: user?.role });

    //   next();
    // };

    //------- Payment Related Apis --------//
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      console.log("Payment info=====>", paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.clubName,
                images: [paymentInfo?.bannerImage],
                description: paymentInfo?.description,
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          status: paymentInfo?.status,
          category: paymentInfo?.category,
          clubId: paymentInfo?.clubId,
          customer: paymentInfo?.customer.email,
          type: paymentInfo?.type,
        },

        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/clubs/${paymentInfo?.clubId}`,
      });

      res.send({ url: session.url });
    });

    // payment-success post api
    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      console.log("Received Session ID:", sessionId);

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const transactionId = session.payment_intent;

        const clubId = { _id: new ObjectId(session?.metadata?.clubId) };

        const existQuery = {
          clubId,
          customer: session?.metadata?.customer,
        };

        console.log("Existing info==========>>>>>", existQuery);

        const existingPayment = await paymentsCollection.findOne(existQuery);

        if (existingPayment) {
          return res.send({
            transactionId,
            message: "Payment already recorded.",
          });
        }

        const club = await clubsCollection.findOne(clubId);

        if (session.status === "complete") {
          const payInfo = {
            transactionId,
            customer: session.metadata.customer,
            status: "paid",
            name: club?.clubName,
            image: club?.bannerImage,
            price: session.amount_total / 100,
            paymentDate: new Date().toISOString(),
            club: {
              ...club,
            },
          };

          console.log(payInfo);

          const result = await paymentsCollection.insertOne(payInfo);

          return res.send(result);
        }
        // pay error
        return res.send({
          transactionId,
          orderId: existingPayment._id,
          message: "Payment not complete.",
        });
      } catch (error) {
        return res.send({
          message: "Internal server error during payment processing.",
        });
      }
    });

    //-------------Membarship apis------------\\
    // app.post("/memberships", async (req, res) => {
    //   const paymentData = req.body;
    //   const query = {
    //     clubId: paymentData.clubId,
    //     membar: paymentData.membar,
    //   };

    //   try {
    //     // Existing Membership Check
    //     const isExistMembership = await membershipsCollection.findOne(query);
    //     if (isExistMembership) {
    //       return res.send({
    //         message: "You have already joined this club.",
    //       });
    //     }

    //     // Insert New Membership
    //     const result = await membershipsCollection.insertOne(paymentData);
    //     res.send(result);
    //   } catch (error) {
    //     res.send({ message: "An internal server error occurred." });
    //   }
    // });

    // app.get("/memberships", async (req, res) => {
    //   const result = await membershipsCollection.find().toArray();
    //   res.send(result);
    // });

    app.get("/memberships/:id", async (req, res) => {
      const clubId = req.params.id;
      const membarEmail = req.query.email;
      const query = {
        clubId: clubId,
        membar: membarEmail,
      };

      const result = await membershipsCollection.findOne(query);
      res.send(result);
    });

    // app.get("/memberships/:id", async (req, res) => {
    //   const id = req.params.id;
    //   const objectId = { _id: new ObjectId(id) };
    //   const result = await membershipsCollection.findOne(objectId);
    //   res.send(result);
    // });

    //------- All ClubsApis --------//
    // create clubs
   
   
    app.post("/clubs", async (req, res) => {
      const clubData = req.body;
      const result = await clubsCollection.insertOne(clubData);
      res.send(result);
    });

    // get all clubs from db
    app.get("/clubs", async (req, res) => {
      const result = await clubsCollection.find().toArray();
      res.send(result);
    });

    // get all single club from db
    app.get("/clubs/:id", async (req, res) => {
      const id = req.params.id;
      const objectId = { _id: new ObjectId(id) };
      const result = await clubsCollection.findOne(objectId);
      res.send(result);
    });

    // get all orders for a customer by email
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // get all orders for a seller by email
    app.get("/manage-orders/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // get all plants for a seller by email
    app.get(
      "/my-inventory/:email",
      verifyJWT,

      async (req, res) => {
        const email = req.params.email;
        const result = await plantsCollection
          .find({ "seller.email": email })
          .toArray();
        res.send(result);
      }
    );

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = {
        email: userData.email,
      };
      const updateLoggedTime = {
        $set: {
          last_loggedIn: userData.last_loggedIn,
        },
      };

      const alreadyExists = await usersCollection.findOne(query);

      if (alreadyExists) {
        console.log("Updating User Info.........");
        const result = await usersCollection.updateOne(query, updateLoggedTime);
        return res.send(result);
      }

      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // save become-seller request
    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      // check request seller
      const alreadyExists = await sellerRequestsCollection.findOne({ email });
      if (alreadyExists) {
        return res
          .status(409)
          .send({ message: "Already requested, Please wait sometimes!" });
      }

      const result = await sellerRequestsCollection.insertOne({ email });
      res.send(result);
    });

    // get all seller requests for admin
    app.get("/seller-requests", verifyJWT, async (req, res) => {
      const result = await sellerRequestsCollection.find().toArray();
      res.send(result);
    });

    // get all users for admin
    app.get("/users", verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const query = { email: { $ne: adminEmail } };
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    // update a user's role
    app.patch("/update-role", verifyJWT, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );

      // delete seller request to sellerCollertion
      await sellerRequestsCollection.deleteOne({ email });

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Club Server is Running....");
});

app.listen(port, () => {
  console.log(`Club Server is running on port ${port}`);
});
