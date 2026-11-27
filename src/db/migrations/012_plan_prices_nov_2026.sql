-- New plan prices and limits (decided 27 Nov 2026, after the competitor and cost review in
-- brochure/SitesForStudios-plan-profit-and-expenses.xlsx). Lower prices, more storage, more staff seats.
-- A Razorpay plan has a fixed amount, so any Razorpay plan IDs saved for the old prices are cleared:
-- create new Razorpay plans at the new prices and save their IDs from the Super Admin plans page.
UPDATE plans SET price_monthly_inr = 999,   price_yearly_inr = 9990,   storage_gb = 25,   staff_seats = 1,  max_studios = 1 WHERE id = 'website';
UPDATE plans SET price_monthly_inr = 2999,  price_yearly_inr = 29990,  storage_gb = 1024, staff_seats = 2,  max_studios = 1 WHERE id = 'starter';
UPDATE plans SET price_monthly_inr = 5999,  price_yearly_inr = 59990,  storage_gb = 2048, staff_seats = 5,  max_studios = 1 WHERE id = 'pro';
UPDATE plans SET price_monthly_inr = 13999, price_yearly_inr = 139990, storage_gb = 5120, staff_seats = 15, max_studios = 3 WHERE id = 'organization';
UPDATE plans SET razorpay_plan_id = NULL, razorpay_plan_id_yearly = NULL WHERE id IN ('starter', 'pro', 'organization');
