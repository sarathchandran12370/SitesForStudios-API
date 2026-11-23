-- Plans can include or exclude client galleries. The Website plan is a studio website only:
-- template site, enquiries, custom domain and a portfolio, but no client accounts, galleries,
-- downloads or face recognition.
ALTER TABLE plans ADD COLUMN client_galleries BOOLEAN NOT NULL DEFAULT true;
