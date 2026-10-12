# The PetroGrid model

Every rule the simulation follows, in the order it applies them, with every constant. This was written by
reading the engine source file by file on 11 October 2026; the file each part comes from is named so it can be
checked. Where an earlier document simplified something, this one says so.

It covers the model only. The README describes how the project is built and run.

Contents

1. One tick, in order
2. What is in a world
3. The S-curve and the three tank signals
4. Learning: the numbers that adjust themselves
5. Plant control: how fast a plant runs
6. Production: mass, energy and rationing
7. Pipelines
8. Buying: when, how much, from whom
9. Prices
10. The market rules
11. Vehicles and dispatch
12. Routes and closures
13. Disruptions and commands
14. Money and accounting
15. The measures: service, cost of a disruption, damage
16. How the world is sized
17. Repeatability
18. Every assumption in one list

---

## 1. One tick, in order

One tick is 15 minutes (0.25 h). Each tick the engine does this, in this order (`sim.cpp`):

| Step | Every tick | Hourly (every 4th tick) |
|---|---|---|
| 1 | Start and end disruptions | |
| 2 | Every tank computes its three signals | |
| 3 | | Plants recompute margin and cost pass-through (market world) |
| 4 | Every process sets its rate and status | |
| 5 | Stopped hours are counted | |
| 6 | Pipelines move | |
| 7 | Processes consume feed and make product; energy is booked | |
| 8 | | Tanks place orders; open orders are given vehicles |
| 9 | Vehicles drive, queue, load and unload | |
| 10 | Caution fades | |
| 11 | | History is recorded for the charts |

Signals are computed before anything moves, so every decision in a tick uses the state at the start of that tick.

---

## 2. What is in a world

| Thing | What it has |
|---|---|
| **Material** | name, phase (liquid, liquefied gas, solid, gas), which transport modes can carry it, base price per tonne. Some are "pseudo" materials (losses, fuel gas, water): they cross the model's edge and never sit in a tank. |
| **Process type** | a chain of units; for each operating mode, the tonnes of every stream per tonne of the basis material; per unit, heat and power per tonne, number of trains; a minimum rate (turndown), a restart time and a ramp rate. |
| **Site** | a position, loading bays per network (road, river, sea), one or more processes, and one tank per material it handles. |
| **Process** | its type, design rate in t/h of basis, and how its trains are split across modes (the flex cracker runs furnaces on ethane, LPG and naphtha 1 : 1 : 6). |
| **Tank** | material, capacity, target fill, starting fill, design inflow and outflow, and whether it "rejects when full". |
| **Pipeline** | material, from tank, to tank, capacity in t/h, its drawn line. |
| **Network** | nodes and edges per mode, each edge with a length and a speed limit. |
| **Fleet** | vehicles by class and home site. |

Three kinds of process sit at the edge of the model:

- a **source** (field, mine) makes product from nothing;
- a **sink** (customer line, port) consumes product into nothing;
- a **plant** converts feed to product.

Each can follow a daily schedule: a factor per hour of the day on its design rate.

---

## 3. The S-curve and the three tank signals

One curve is used for every smooth limit in the model:

```
t = (x - low) / (high - low), kept between 0 and 1
S(x) = t × t × (3 - 2t)
```

Every tick, every tank computes three numbers (`signals.cpp`):

```
hours of stock = level ÷ design outflow
hours of room  = (capacity - level) ÷ design inflow
hours covered  = (level + tonnes on order) ÷ design outflow

Feed     f = S( hours of stock ÷ pickup gap ),              low 0.25, high 1.25
Room     h = S( hours of room  ÷ pickup gap ),              low 0.10, high 1.00
Urgency  u = 1 - S( hours covered ÷ (lead time × caution) ), low 1.0,  high 2.5
```

| Signal | Is 1 when | Is 0 when |
|---|---|---|
| Feed | stock covers more than 1.25 pickup gaps (5 h at the starting gap) | less than 0.25 (1 h) |
| Room | room for more than 1.0 pickup gap (4 h) | less than 0.10 (24 min) |
| Urgency | stock and orders cover less than 1 lead time | more than 2.5 lead times |

A tank nothing draws from has Feed 1 and Urgency 0. A tank nothing fills has Room 1.

The pickup gap starts at 4 hours and the lead time at a set value per tank; both then learn (section 4).

---

## 4. Learning: the numbers that adjust themselves

Three numbers per tank change during a run (`adaptation.cpp`).

| Number | Starts at | Changes when | Rule | Limits |
|---|---|---|---|---|
| **Lead time** (buying tanks) | 24 h by default; 64 h for truck-fed tanks and 48 to 64 h for barge- and ship-fed tanks in this world | a delivery completes | new = 0.8 × old + 0.2 × hours that order took, from placing to unloading | 0.5× to 4× the start |
| **Pickup gap** (selling tanks) | 4 h | a vehicle starts loading | new = 0.8 × old + 0.2 × hours since the previous pickup | 0.5× to 4× the start |
| **Caution** (buying tanks) | 1 | the tank runs dry | × 1.25 | 1 to 2 |

Caution fades: each tick it loses (caution − 1) × 0.25 h ÷ 720 h, a 30-day time constant.

What this does: a tank that keeps waiting long for deliveries orders earlier; a product tank that is collected
rarely starts slowing its plant earlier as it fills; a tank that ran dry holds more stock for a while.

---

## 5. Plant control: how fast a plant runs

All in `control.cpp`.

### 5.1 Capacity

```
unit capacity (in basis t/h) = capacity per train × trains online ÷ that unit's throughput per tonne of basis
R_max = the smallest unit capacity, and never more than the design rate
```

Trains are sized at 110% of nameplate, so a plant with one train down can often still reach its design rate. With
no train left on any unit, R_max is zero.

### 5.2 The governor

```
governor g = the lowest of ( Feed of every feed tank , Room of every product tank )
```

A product tank marked "rejects when full" is left out: the plant sees it as always having room.

In the market world a third limit is added (section 10.3):

```
margin limit = minimum rate share + (1 - minimum rate share) × margin signal
desired rate = R_max × the lower of ( g , margin limit )
```

### 5.3 The status machine

A plant is in one of four states.

| State | What happens | Leaves when |
|---|---|---|
| **Running** | rate ramps toward the desired rate | desired falls below the minimum rate, or g reaches 0 |
| **Holding at minimum** | desired is below the minimum rate but the tanks can still sustain it: the plant holds its minimum rate | desired recovers, or g reaches 0 |
| **Shut down** | rate ramps to 0 | g rises above 0.6 |
| **Restarting** | rate is 0 for the process's restart time | the timer ends: it resumes at its minimum rate |

A plant shuts down at once if R_max is zero or below its minimum rate (too many trains lost).

The 0.6 threshold stops a plant flickering on and off: it has to see tanks clearly recovered before it starts the
restart clock.

### 5.4 Ramps and caps

The rate moves toward its target by at most (ramp rate × design rate × 0.25 h) per tick. One exception: a rate
above R_max is cut to R_max at once, because a lost train is a physical limit.

### 5.5 Sources and customers

- **Source:** target = design rate × schedule × supply-shock multiplier, capped by its capacity, then multiplied
  by the Room signal of each product tank. It ramps like a plant but never shuts down.
- **Customer (sink):** demand = design rate × schedule × demand-shock multiplier (× the demand factor in the
  market world). It consumes that, or whatever stock allows if less. No ramp, no shutdown.

---

## 6. Production: mass, energy and rationing

All in `production.cpp`.

### 6.1 Mass

For each process and each operating mode:

```
tonnes of basis this tick = rate × share of trains on that mode × 0.25 h
each stream               = tonnes of basis × that stream's tonnes per tonne   (negative = consumed)
```

Recipes are fixed ratios. Examples: per tonne of raw gas, 0.787 methane, 0.078 ethane, 0.074 LPG, 0.021 naphtha;
per tonne of ethane cracked, 0.78 ethylene; per tonne of chlorine, 1.648 t of salt in and 1.128 t of caustic soda
out.

Because co-products come in fixed ratios, one product with nowhere to go slows the whole plant, and its other
products run short. This is the root of most cascades.

### 6.2 Rationing within a tick

If a feed tank holds less than the tick needs, or a product tank has less room than the tick makes, the whole
process is scaled down for that tick by the tightest ratio. No tank goes below zero or above its capacity.

### 6.3 Reject when full

A product tank marked this way stores what fits and discards the rest as a loss. The gas plant's ethane and
similar single-outlet streams use it, so one full tank cannot shut the plant.

### 6.4 Energy

```
heat needed    = sum over units of ( heat per tonne × tonnes )
fuel gas credit = fuel gas the process made × 48 GJ per tonne
heat bought    = heat needed - fuel gas credit, never below zero
energy cost    = heat bought × $8 per GJ + power × $80 per MWh
```

### 6.5 Customer accounting

Each tick, for each customer line:

```
unmet     = demand - what it actually consumed            (valued at the material's base price)
priced out = demand ÷ demand factor - demand              (market world only; valued at base price)
```

A customer is "starved" when it consumed less than 99.9% of its demand; the first tick of that is logged as
"cannot get enough …".

---

## 7. Pipelines

Every tick, each pipeline moves (`pipelines.cpp`):

```
wanted = the receiving tank's design outflow + ( target level - current level ) ÷ 4 h
flow   = wanted, kept between 0 and the pipe's capacity,
         and no more than the sender holds or the receiver has room for
```

So a pipeline holds the receiving tank at its target for as long as the sender has stock; the slack sits in the
sender's tank. No order, no vehicle, no freight. A pipeline sale is valued at the base price in the accounts.
A trade block between the two sites sets the flow to zero.

---

## 8. Buying: when, how much, from whom

Hourly, in `procurement.cpp`.

### 8.1 Who buys

A tank buys if something draws from it, it is not fed by pipeline, and it is a feed tank. It buys when its
Urgency is above zero (or, in the market world, also when a price is good: section 10.1).

### 8.2 How much

```
wanted = target fill × capacity - ( level + tonnes already on order )
```

cut into lots of at most one vehicle load, up to 3 lots per tank per hour in this world. The most urgent tank is
served first.

**Minimum lot.** A lot smaller than the lower of (80% of the vehicle's capacity) and (40% of the tank's target
stock) is not placed; the tank waits for a later hour. This stops a tank ordering an hour's draw at a time.

### 8.3 Who can sell and carry

A candidate is a seller tank of the same material at another site, plus a vehicle class, where all of these hold:

- the material can travel in that class's mode and the class carries its phase;
- both sites have bays on that network and an open route joins them;
- a vehicle of that class is somewhere that can reach the seller;
- the seller has unreserved stock for the lot.

### 8.4 The choice

```
delivered cost per tonne = asking price
                         + freight rate × kilometres
                         + urgency × $0.50 × trip hours        (the value of time)
                         + switching charge                    (5% of base for a non-contract seller; 0 in this world)
```

The lowest delivered cost wins. Ties go to the lower seller, then the lower class.

### 8.5 Booking

The order joins the dispatch queue. The seller's stock for it is reserved, and the buyer's "on order" tonnes
rise, which lowers its urgency at once.

### 8.6 Ports that export

A tank marked as an export buyer is a patient buyer: it has a fixed low urgency of 0.1 and only buys from a
seller whose tank is more than 70% full. Exports take surplus and never compete with the domestic chain.

### 8.7 The price index

Each material has an index that starts at 1. Each booked trade pulls it 10% of the way toward (price paid ÷ base
price). Each lot that finds no seller at all multiplies it by 1.01. It is kept between 0.25 and 4. It is a
readout for the Prices chart; it does not feed back into asking prices.

---

## 9. Prices

```
asking price = base × ( 1 + 0.5 × ( 1 - 2 × seller's fill ) )
bid          = base × ( 1 + 0.5 × buyer's urgency )
price paid   = ( asking price + bid ) ÷ 2
```

| Seller's tank | Asks | | Buyer's urgency | Bids |
|---|---|---|---|---|
| empty | 50% above base | | 0 | base |
| half full | base | | 0.5 | 25% above |
| full | 50% below base | | 1 | 50% above |

In a shared session a player's markup (−20% to +30%) multiplies the asking price.

Because a bid is never below base, the average price paid sits above base whenever sellers are near half full.
This is why prices settle above base in the market world even when nothing is wrong.

---

## 10. The market rules

Three switches in the world file, all off in the standard world and on in the market world.

### 10.1 Price-aware buying (`procurement.cpp`)

With r = best asking price ÷ base, and "cover" = stock and orders in lead times:

```
c = +S( (1 - r) ÷ 0.1 )   if r ≤ 1        how cheap, 0 to 1
c = -S( (r - 1) ÷ 0.1 )   if r > 1        how dear, 0 to -1

order when cover is below:  2.5 + |c| × ( 4.0 - 2.5 )   if cheap,   2.5 + |c| × ( 1.5 - 2.5 )   if dear
fill to:                    target + |c| × ( 90% - target )  if cheap,   target + |c| × ( 50% - target )  if dear
```

So at 90% of base or less the tank orders with up to 4 lead times of cover and fills to 90%; at 110% or more it
waits until 1.5 lead times and fills to 50%. With cover under 1 lead time it buys to its own target at any price.

### 10.2 Demand that reacts to price (`control.cpp`, `production.cpp`)

```
price memory   = moves 20% of the way to each new lot's price
demand factor  = ( price memory ÷ base ) ^ -0.2, kept between 0.6 and 1.2
customer wants = normal demand × demand factor
```

### 10.3 Margin and cost pass-through (`market.cpp`), hourly

For each plant, per tonne of basis:

```
cost     = sum( feed value × usage ) + energy
revenue  = sum( product value × yield )
```

where a feed bought by vehicle is valued at its price memory, a feed arriving by pipeline or made on site at its
maker's price (times the maker's markup on a pipeline), and a product at the average price it has been sold for.

```
margin signal = S( margin ÷ ( 0.5 × margin at base prices ) )          1 when healthy, 0 at no margin
cost rise     = ( cost - cost at base prices ) ÷ revenue at base prices, kept between -30% and +100%
cost floor    = ( cost ÷ revenue at base prices ) × the product's base price

asking price  = the higher of ( section 9 asking price + base × cost rise ,  cost floor × ( 1 - seller's fill ) )
```

- A plant whose margin at base prices is under 2% of product value ignores the margin signal.
- The floor fades as the tank fills: an empty seller will not go below cost, a full one may, because it has to
  clear product to keep running.
- A price rise moves down the chain about one stage an hour.

---

## 11. Vehicles and dispatch

In `dispatch.cpp`.

| Class | Carries | Load | Speed | Loads at | Freight, $ per tonne-km |
|---|---|---|---|---|---|
| Tank truck | liquids | 25 t | 70 km/h | 50 t/h | 0.10 |
| Pressurised truck | liquefied gases | 20 t | 70 km/h | 40 t/h | 0.14 |
| Bulk truck | solids | 25 t | 70 km/h | 50 t/h | 0.10 |
| Tank barge | liquids | 2,000 t | 12 km/h | 400 t/h | 0.025 |
| Dry barge | solids | 1,500 t | 12 km/h | 300 t/h | 0.025 |
| Tanker | liquids | 40,000 t | 26 km/h | 2,500 t/h | 0.004 |
| Gas ship | liquefied gases | 12,000 t | 30 km/h | 800 t/h | 0.008 |
| Dry bulk ship | solids | 20,000 t | 24 km/h | 1,000 t/h | 0.005 |

**The queue.** Open orders are served first come, first served, with urgency worth a head start of up to 48
hours (sort key = time placed − urgency × 48 h). An old order can never be overtaken forever.

**One trip.**

1. On the hour each order gets the idle vehicle of its class that can reach the pickup soonest.
2. The vehicle drives empty to the seller.
3. It queues for a bay. Bays are per site and per network, first come, first served, and are shared by loading
   and unloading.
4. It loads at its loading rate, taking product out of the seller's tank, and leaves when the order's tonnes are
   aboard.
5. It drives to the buyer, queues for a bay, and unloads at the same rate, never faster than the buyer's tank
   has room.
6. When the last tonne is off, the trade is booked, the buyer's lead time learns from it, and the vehicle becomes
   idle where it stands. It does not go home.

**Movement.** A vehicle moves at the lower of its own speed and the edge's limit. Time left over when it reaches
a junction carries into the next edge.

**Orders nothing can carry** are cancelled: the seller's reserved stock is released and the buyer orders again by
another seller or class.

---

## 12. Routes and closures

- The network is built from the drawn lines: nearby points are merged into junctions, sites attach to a network
  within 12 km, and corners are rounded with an 8 km radius. Distance is the real length of the rounded line.
- Paths are the fastest open route per mode, recomputed when an edge opens or closes.
- **Route closure:** a vehicle on the closed stretch finishes it, then re-plans at the next junction, or waits if
  there is no way. A vehicle that finished loading with no way out stays at the berth with its cargo.
- **Hurricane:** every road vehicle moves at a quarter speed. Buyers' quoted trip times are not adjusted.
- **Water restriction:** no barge or ship sets off; those already under way finish their trip.

---

## 13. Disruptions and commands

In `events.cpp` and `sim.cpp`. A disruption starts on the tick after it is issued.

| Command | What it does | Ends |
|---|---|---|
| Unit outage | takes a number of trains of one unit down | after its duration: the trains return |
| Site shutdown | takes every unit at a site down | after its duration |
| Supply shock | multiplies a source's output | after its duration |
| Demand shock | multiplies a customer's demand | after its duration |
| Route closure | closes one edge, or every edge between two sites | after its duration, unless another closure still holds it |
| Hurricane | roads at quarter speed (default 72 h) | after its duration |
| Water restriction | barges and ships held (default 120 h) | after its duration |
| End events | ends every running or queued disruption at the next tick | |
| Unit switch (shared sessions) | a player takes a unit down or brings it back | only when the player reverses it |
| Rate share (shared sessions) | caps a site's rate at a share of design. The phone's slider stops at the plant's minimum rate; a share set below the minimum rate shuts the plant down. | until changed |
| Markup (shared sessions) | multiplies a site's asking prices, −20% to +30% | until changed |
| Trade block (shared sessions) | stops one site selling to, or buying from, another, pipelines included | until lifted |

If two shocks hit the same site, the latest wins. Random unit failures exist in the engine but are switched off.

---

## 14. Money and accounting

| Item | How it is counted | When |
|---|---|---|
| Purchase | tonnes × price paid: revenue to the seller, feed cost to the buyer | on delivery |
| Freight | tonnes × kilometres × the class's rate | on delivery; the empty drive to the pickup is free |
| Pipeline sale | tonnes × base price | every tick |
| Energy | heat bought × $8/GJ + power × $80/MWh | every tick |
| Unmet demand | tonnes a customer wanted and did not get × base price | every tick |
| Priced-out demand | tonnes a customer gave up because of price × base price | every tick, market world |
| Rejected product | tonnes discarded by a reject-when-full tank × base price | every tick |
| Stock | every tank's level, plus cargo on vehicles, × base price | when asked |

Not counted anywhere: fixed costs, wages, capital, penalties, taxes.

---

## 15. The measures

### 15.1 Service

```
service = 1 - unmet tonnes ÷ demanded tonnes
```

The world's check (`crx-report`, run in the tests) passes when service is at least 95% at days 7, 30 and 60, every
customer is above 90%, and no plant is starved of feed.

### 15.2 The cost of a disruption (single player)

The session is copied and both copies run 30 days ahead: one as it is, one rebuilt without its disruptions.

```
cost = ( unmet $ with - unmet $ without )
     + ( freight with - freight without )
     + ( energy with - energy without )
     - ( stock value at the end with - stock value at the end without )
```

The stock term is what keeps an outage from looking like an energy saving. The first time each customer runs dry
and each plant shuts down in the disrupted copy, and not in the other, is listed as the countdown.

### 15.3 Damage (shared sessions)

Beside the session the server steps a copy with no changes at all, and one copy per player that receives every
command except that player's.

```
lost sales        = unmet $ + priced-out $
damage            = lost sales in the session - lost sales in the unchanged copy
a player's damage = lost sales in the session - lost sales in the copy without that player
```

A site is listed as broken when, against the copy it is compared with, it was stopped at least 6 hours longer, or
made under 90% as much, or lost over $5,000 more sales. A pipeline is broken when it carried under 90% as much.
"Stopped" counts any quarter hour in which a process at the site was shut down or restarting, or nothing at the
site was running.

A player's figure is exact for "the session without them". The figures do not sum to the total, because moves
interact.

---

## 16. How the world is sized

`tools/worlds/build_erwin_world.py` turns the hand-drawn map into a world file. The map fixes where things are;
the script decides how big they are.

- **Rates are closed forward from the sources.** Starting from the gas plant (500 t/h of raw gas) and the fields,
  each plant is sized to take what its suppliers make and each customer to take what the chain delivers, so
  every tonne made has somewhere to go.
- **Customers ask for 98%** of what the chain can make; **sources can make 3% more** than needed. Plants have no
  spare: giving them 10% gridlocked the world after any upset.
- **Tank size** = days of cover × 24 × the larger of design inflow and outflow. Typical: 7 days at polymer plants
  and their customers, 10 to 12 days for barge- and ship-fed tanks, 16 days for shipped fuels.
- **By-products with one buyer** (benzene, propylene, naphtha, solvent, cracker LPG and gasoline) have very large
  tanks, 45 to 400 days, on purpose. With small ones an outage at the one buyer filled the tank and shut the
  plant that makes it, and the refinery, flex cracker and styrenics could lock each other out for good.
- **Target fill** is 70% for every tank.
- **Fleet** is sized from the tonne-kilometres each class has to move, with 30% spare.
- **Bays** decide which networks a site can use. The fuel depot and Port terminal B have no truck gate, so a fuel
  shortage cannot turn into hundreds of truck orders for a ship-sized delivery.
- **Start.** The world opens already running: plants at design rate, tanks at their set levels, vehicles at home.

The market world is the same build with the three market switches on.

---

## 17. Repeatability

The same world, seed and list of commands give the same run, bit for bit. Three things depend on it:

- **Back in time:** the session is rebuilt and its commands replayed up to the chosen moment.
- **The cost of a disruption** and **damage:** both compare two runs, and any difference between them can only
  come from the commands that differ.
- **The tests:** a fingerprint of the state after 60 days is checked, so an accidental change to behaviour is
  caught.

---

## 18. Every assumption in one list

**Network**
1. The network is a typical one, not a real company's; plants are sized so it balances.
2. It is closed: no imports, exports or world price.
3. One tank per material per site.

**Plants**
4. Fixed yields per operating mode; co-products in fixed ratios.
5. Capacity is limited by the tightest unit; trains are sized at 110% of nameplate.
6. A plant can turn down to a minimum rate and no further; below it, it shuts down.
7. A restart takes a fixed time and resumes at minimum rate.
8. Rate changes are limited by a ramp, except the loss of a train, which is instant.
9. Energy per tonne is fixed per unit; fuel gas offsets heat at 48 GJ per tonne.

**Sources and customers**
10. Sources produce at design unless shocked or out of room.
11. Customers demand at design unless shocked (and, in the market world, by price).
12. Unmet demand is lost, not backlogged.

**Inventory and buying**
13. A reorder-point policy: order when cover is short, up to a target fill.
14. Lots are whole vehicle loads, with a minimum lot.
15. The cheapest delivered offer wins; slow transport is penalised when the buyer is urgent.
16. Buyers learn their lead time and become cautious after running dry.
17. Sellers learn how often they are collected.

**Transport**
18. Constant speeds; no traffic, breakdowns, driver hours or weather except the two weather scenarios.
19. One vehicle carries one order: one material, one seller, one buyer.
20. Roads and lanes have no capacity; only bays limit throughput.
21. A vehicle stays where it unloaded until its next job.
22. Pipelines follow the receiver's draw and cost nothing to run.

**Prices**
23. Asking price is linear in the seller's fill, at most 50% either side of base.
24. Bid rises with urgency and is never below base.
25. Price paid is halfway between ask and bid.
26. Every trade is spot.

**Market world**
27. Buyers shift the timing and size of orders with price, never their safety.
28. Demand elasticity is −0.2, limited to 60–120% of normal.
29. A plant with no margin turns down to minimum; it does not shut for price.
30. Feed cost rises pass into product prices; the cost floor fades as the seller's tank fills.

**Money**
31. Heat $8/GJ, power $80/MWh, freight per tonne-kilometre by class.
32. Lost sales, stock and rejected product are valued at base price.
33. No fixed costs, wages, capital or penalties.

**Simulation**
34. 15-minute ticks; ordering and dispatch hourly.
35. Nothing fails by chance.
36. Exactly repeatable.

---
