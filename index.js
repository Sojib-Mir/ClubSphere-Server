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
    const eventRegisterCollection = db.collection("eventRegister");
    const clubsCollection = db.collection("clubs");
    const managerRequestsCollection = db.collection("managerRequests");
    const paymentsCollection = db.collection("payments");
    const membershipsCollection = db.collection("memberships");

    //-------Role Middleware-------\\
    // admin's middleware
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };

    // Manager's middleware
    const verifyMANAGER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "manager")
        return res
          .status(403)
          .send({ message: "Manager only Actions!", role: user?.role });

      next();
    };

    //------- Payment Related Apis --------//
    // payment-create api
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

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

    // create payment-success api
    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const transactionId = session.payment_intent;
        const clubId = { _id: new ObjectId(session?.metadata?.clubId) };

        const existingPayment = await paymentsCollection.findOne({
          transactionId,
        });

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
            status: "Paid",
            name: club?.clubName,
            image: club?.bannerImage,
            price: session.amount_total / 100,
            paymentDate: new Date().toISOString(),
            club: {
              ...club,
            },
          };

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
    // create membership data from db
    app.post("/memberships", async (req, res) => {
      const paymentData = req.body;
      const query = {
        clubId: paymentData.clubId,
        membar: paymentData.membar,
      };

      try {
        // Existing Membership Check
        const isExistMembership = await membershipsCollection.findOne(query);
        if (isExistMembership) {
          return res.send({
            message: "You have already joined this club.",
          });
        }

        // Insert New Membership
        const result = await membershipsCollection.insertOne(paymentData);
        res.send(result);
      } catch (error) {
        res.send({ message: "An internal server error occurred." });
      }
    });

    // get membership data from db
    app.get("/memberships", verifyJWT, verifyMANAGER, async (req, res) => {
      const result = await membershipsCollection.find().toArray();
      res.send(result);
    });

    // get membership single data from db
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

    //------- All ClubsApis --------//
    // create clubs data from db
    app.post("/clubs", async (req, res) => {
      const clubData = req.body;
      const lastClub = await clubsCollection
        .find()
        .sort({ clubId: -1 })
        .limit(1)
        .toArray();

      let nextId;

      if (lastClub.length === 0) {
        nextId = 1000;
      } else {
        nextId = lastClub[0].clubId + 1;
      }

      clubData.clubId = nextId;

      const result = await clubsCollection.insertOne(clubData);
      res.send(result);
    });

    // get all clubs data from db
    app.get("/clubs", async (req, res) => {
      const { status, search, filter } = req.query;
      const queryFilter = {};

      if (status) {
        queryFilter.status = status;
      }

      if (filter) {
        queryFilter.category = filter;
      }

      if (search) {
        queryFilter.clubName = { $regex: search, $options: "i" };
      }

      try {
        const result = await clubsCollection.find(queryFilter).toArray();

        res.send(result);
      } catch (error) {
        console.error("Error fetching clubs:", error);
        res.status(500).send({ message: "Failed to fetch club data" });
      }
    });

    // get recent 8 clubs data from db
    app.get("/recent-clubs", async (req, res) => {
      const status = req.query.status;
      const result = await clubsCollection
        .find({ status })
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();
      res.send(result);
    });

    // get single club data from db
    app.get("/clubs/:id", async (req, res) => {
      const id = req.params.id;
      const objectId = { _id: new ObjectId(id) };
      const result = await clubsCollection.findOne(objectId);
      res.send(result);
    });

    // delete single club data from db
    app.delete("/clubs/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const objectId = { _id: new ObjectId(id) };
        const result = await clubsCollection.deleteOne(objectId);

        if (result.deletedCount === 1) {
          res.send({ success: true, message: "Club deleted successfully." });
        } else {
          res.status(404).send({ success: false, message: "Club not found." });
        }
      } catch (error) {
        if (error.name === "BSONError" || error.name === "CastError") {
          console.error("BSON or Invalid ID Error:", error.message);
          return res
            .status(400)
            .send({ success: false, message: "Provided ID is invalid." });
        }

        console.error("Server Delete Error:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error occurred during deletion.",
        });
      }
    });

    // create event data from db
    app.post("/events", async (req, res) => {
      const eventData = req.body;
      const result = await eventsCollection.insertOne(eventData);
      res.send(result);
    });

    // get all events from db
    app.get("/events", async (req, res) => {
      const { search } = req.query;
      const queryFilter = {};

      if (search) {
        queryFilter.title = { $regex: search, $options: "i" };
      }

      try {
        const result = await eventsCollection.find(queryFilter).toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching events:", error);
        res.status(500).send({ message: "Failed to fetch events data" });
      }
    });

    // get single event data from db
    app.get("/events/:id", async (req, res) => {
      const id = req.params.id;
      const objectId = { _id: new ObjectId(id) };
      const result = await eventsCollection.findOne(objectId);
      res.send(result);
    });

    // delete single data event from db
    app.delete("/events/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const objectId = { _id: new ObjectId(id) };
        const result = await eventsCollection.deleteOne(objectId);

        if (result.deletedCount === 1) {
          res.send({ success: true, message: "Event deleted successfully." });
        } else {
          res.status(404).send({ success: false, message: "Event not found." });
        }
      } catch (error) {
        if (error.name === "BSONError" || error.name === "CastError") {
          console.error("BSON or Invalid ID Error:", error.message);
          return res
            .status(400)
            .send({ success: false, message: "Provided ID is invalid." });
        }

        console.error("Server Delete Error:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error occurred during deletion.",
        });
      }
    });

    //------- All Events Register Apis --------//
    // create eventRegister
    app.post("/event-register", async (req, res) => {
      const eventRegisterData = req.body;
      const { userEmail, eventId } = eventRegisterData;

      const existingRegistration = await eventRegisterCollection.findOne({
        userEmail: userEmail,
        eventId: eventId,
      });

      if (existingRegistration) {
        return res.status(400).send({
          message: "You have already registered for this event.",
          success: false,
        });
      }

      const result = await eventRegisterCollection.insertOne(eventRegisterData);
      res.send(result);
    });

    // get all eventRegister from db
    app.get("/event-register", verifyJWT, async (req, res) => {
      const result = await eventRegisterCollection.find().toArray();
      res.send(result);
    });

    // get all single eventRegister from db
    app.get("/event-register/:id", async (req, res) => {
      const eventId = req.params.id;
      const userEmail = req.query.email;
      const query = {
        eventId: eventId,
        userEmail: userEmail,
      };

      const result = await eventRegisterCollection.findOne(query);
      res.send(result);
    });

    //------- All Payments Apis --------//
    // get all payments from db
    app.get("/payments", verifyJWT, async (req, res) => {
      const result = await paymentsCollection.find().toArray();
      res.send(result);
    });

    // get all single payment from db
    app.get("/payments/:id", async (req, res) => {
      const id = req.params.id;
      const customer = req.query.email;
      const query = {
        id: id,
        customer: customer,
      };

      const result = await paymentsCollection.findOne(query);
      res.send(result);
    });

    // get my-club
    app.get("/my-clubs", verifyJWT, async (req, res) => {
      const customer = req.query.email;
      const myClubsData = await paymentsCollection.find({ customer }).toArray();
      res.send(myClubsData);
    });

    // get my-event
    app.get("/my-events", verifyJWT, async (req, res) => {
      const userEmail = req.query.email;
      const myClubsData = await eventRegisterCollection
        .find({ userEmail })
        .toArray();
      res.send(myClubsData);
    });

    // get my-payment-history
    app.get("/my-payment-history", verifyJWT, async (req, res) => {
      const customer = req.query.email;
      const myClubsData = await paymentsCollection.find({ customer }).toArray();
      res.send(myClubsData);
    });

    // get all clubs for a manager by email
    app.get("/manage-clubs", verifyJWT, verifyMANAGER, async (req, res) => {
      const result = await clubsCollection
        .find({ managerEmail: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // update single club data
    app.patch(
      "/manage-clubs/:id",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        try {
          const id = req.params.id;
          const updatedClubData = req.body;
          const query = { _id: new ObjectId(id) };

          const updateDoc = {
            $set: {
              ...updatedClubData,
            },
          };

          const result = await clubsCollection.updateOne(query, updateDoc);

          if (result.matchedCount === 0) {
            return res.status(404).send({
              message:
                "Club not found or you are not authorized to update this club.",
            });
          }

          res.send(result);
        } catch (error) {
          console.error("Error updating club:", error);
          res.status(500).send({ message: "Failed to update club.", error });
        }
      }
    );

    // get all events for a manager by email
    app.get("/manage-events", verifyJWT, verifyMANAGER, async (req, res) => {
      const result = await eventsCollection
        .find({ managerEmail: req.tokenEmail })
        .toArray();

      res.send(result);
    });

    // update single event data
    app.patch(
      "/manage-events/:id",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        try {
          const id = req.params.id;
          const updatedEventData = req.body;
          const query = { _id: new ObjectId(id) };

          const updateDoc = {
            $set: {
              ...updatedEventData,
            },
          };

          const result = await eventsCollection.updateOne(query, updateDoc);

          if (result.matchedCount === 0) {
            return res.status(404).send({
              message:
                "Event not found or you are not authorized to update this event.",
            });
          }

          res.send(result);
        } catch (error) {
          console.error("Error updating event:", error);
          res.status(500).send({ message: "Failed to update event.", error });
        }
      }
    );

    // get all memberships in club for a manager by email
    app.get(
      "/manage-memberships",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const result = await membershipsCollection
          .find({ managerEmail: req.tokenEmail })
          .toArray();
        res.send(result);
      }
    );

    // delete all single memberships in club for a manager by email
    app.delete("/manage-memberships/:id", async (req, res) => {
      const id = req.params.id;
      const objectId = { _id: new ObjectId(id) };
      const result = await membershipsCollection.deleteOne(objectId);
      res.send(result);
    });

    // get all Event Register data for a manager by email
    app.get("/register-event", verifyJWT, verifyMANAGER, async (req, res) => {
      const result = await eventRegisterCollection
        .find({ managerEmail: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // delelte all single Event Register data for a manager by email
    app.delete("/register-event/:id", async (req, res) => {
      const id = req.params.id;
      const objectId = { _id: new ObjectId(id) };
      const result = await eventRegisterCollection.deleteOne(objectId);
      res.send(result);
    });

    //-----------------USER INFO---------------------\\
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

    //-----------------ONLY ADMIN ACCESS APIS---------------------\\
    // save become-manager request for only admin
    app.post("/become-manager", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      // check request manager
      const alreadyExists = await managerRequestsCollection.findOne({ email });
      if (alreadyExists) {
        return res
          .status(409)
          .send({ message: "Already requested, Please wait sometimes!" });
      }
      const result = await managerRequestsCollection.insertOne({ email });
      res.send(result);
    });

    // get all manager requests for only admin
    app.get("/manager-requests", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await managerRequestsCollection.find().toArray();
      res.send(result);
    });

    // get all payment-history for only admin
    app.get("/payment-history", verifyJWT, verifyADMIN, async (req, res) => {
      const paymentHistory = await paymentsCollection.find().toArray();
      res.send(paymentHistory);
    });

    // get all users for only admin
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const query = { email: { $ne: adminEmail } };
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    // update a user's role only admin
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;

      const updateRoleResult = await usersCollection.updateOne(
        { email: email },
        { $set: { role: role } }
      );

      await managerRequestsCollection.deleteOne({
        email: email,
      });

      res.send(updateRoleResult);
    });

    // update a club's approved only admin
    app.patch("/club-approved", verifyJWT, verifyADMIN, async (req, res) => {
      const { managerEmail, status, clubId } = req.body;

      const filter = {
        managerEmail: managerEmail,
        clubId: clubId,
      };

      const updateClub = {
        $set: { status: status },
      };

      const result = await clubsCollection.updateOne(filter, updateClub);

      console.log(result);

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
  res.send("Clubs Phere Server is Running....");
});

app.listen(port, () => {
  console.log(`Clubs Phere Server is Running on Port ${port}`);
});
