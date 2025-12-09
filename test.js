app.post('/create-checkout-session', async (req, res) => {

      const paymentinfo = req.body
      console.log(paymentinfo)

      const session = await stripe.checkout.sessions.create({

        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentinfo?.name,

              },
              unit_amount: paymentinfo?.price * 100
            },
            quantity: 1,
          },
        ],
        customer_email: paymentinfo?.email,
        mode: 'payment',
        metadata: {
          type: paymentinfo?.type,
          status: paymentinfo?.status,
          category: paymentinfo?.category,
          clubId: paymentinfo?.clubId,
          member: paymentinfo?.email
          // 
        },
      //
        success_url: ${process.env.DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID},
        cancel_url: ${process.env.DOMAIN}/payment-cancel/${paymentinfo?.clubId}
      })

     res.send({ url: session.url })
    })


app.post("/payment-success", async (req, res) => {
  const { sessionId } = req.body;

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  const transection = await membershipPayments.findOne({
    transectionId: session.payment_intent,
  });

  if (transection) if (transection) return;

  const plant = await clubsCollection.findOne({
    _id: new ObjectId(session.metadata.clubId),
  });

  if (session.status === "complete" || plant) {
    const orderinfo = {
      clubId: session.metadata.clubId,
      transectionId: session.payment_intent,
      member: session.metadata.member,
      status: "paid",
      price: session.amount_total / 100,
      name: plant?.clubName,
      club: {
        ...plant,
      },
    };

    orderinfo.created_At = new Date().toLocaleDateString();

    console.log("orderinformation", orderinfo);
    const result = await membershipPayments.insertOne(orderinfo);

    return res.send(result);
  }

  return res.send({
    transectionId: session.payment_intent,
    orderId: transection._id,
  });
});


// _id
// 69369e47c2a325b31e3861bd
// clubId
// "67c5a001c101a1a1a0010015"
// transectionId
// "pi_3Sc10oGkNDeErJi71YDqwYHJ"
// member
// "omor12@gmail.com"
// status
// "paid"
// price
// 20
// name
// "Gamers Hub"

// club
// Object

// created_At
// "12/8/2025"
