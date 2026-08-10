-- Backfill search aliases onto categories that were seeded before aliases existed.
--
-- New workspaces get them at signup. Everyone who signed up earlier has an empty
-- list, so `poribohon` finds nothing in their books while it works for a
-- colleague who joined a day later — the same word answering differently
-- depending on when you registered.
--
-- Two guards make this safe to run and safe to re-run:
--
--   isSystem = true       a category the user created themselves is theirs; we
--                         do not put words in it.
--   searchAliases = '{}'  somebody who has already curated a list, or who
--                         renamed a seeded row and gave it their own aliases,
--                         is never overwritten.
--
-- Matching is on (kind, name) — the English name, which is stable — rather than
-- nameBn, which a user may have edited.

WITH seed(name, kind, aliases) AS (
  VALUES
  ('Salary', 'INCOME', ARRAY['Beton', 'Betan', 'Maine', 'Salary', 'Bonus']::text[]),
  ('Business', 'INCOME', ARRAY['Bebsha', 'Bebsa', 'Byabsa', 'Business', 'Dokan', 'Shop', 'Bikri', 'Sales']::text[]),
  ('Freelance', 'INCOME', ARRAY['Frilanse', 'Frilancing', 'Outsourcing', 'Upwork', 'Fiverr']::text[]),
  ('Rental income', 'INCOME', ARRAY['Bari Bhara', 'Bari Vara', 'Bhara', 'Vara', 'Rent income', 'Tenant']::text[]),
  ('Profit / interest', 'INCOME', ARRAY['Munafa', 'Shud', 'Sud', 'Labh', 'Interest', 'Profit', 'Dividend', 'FDR', 'Sanchaypatra']::text[]),
  ('Gift', 'INCOME', ARRAY['Upohar', 'Uphar', 'Gift', 'Salami', 'Eidi', 'Hadiya']::text[]),
  ('Other income', 'INCOME', ARRAY['Onnanno', 'Ononno', 'Bibidh', 'Other', 'Misc']::text[]),
  ('Food & groceries', 'EXPENSE', ARRAY['Khabar', 'Bajar', 'Khabar O Bajar', 'Kacha Bajar', 'Restaurant', 'Grocery', 'Food', 'Hotel', 'Nasta', 'Foodpanda', 'Chaldal', 'Shwapno', 'Agora', 'Meena Bazar']::text[]),
  ('House rent', 'EXPENSE', ARRAY['Basa Bhara', 'Basa Vara', 'Barir Bhara', 'Flat Bhara', 'Bhara', 'Vara', 'Rent']::text[]),
  ('Utilities', 'EXPENSE', ARRAY['Utility', 'Bidyut', 'Biddut', 'Electricity', 'Current Bill', 'Gas', 'Pani', 'Water', 'Bill', 'WASA', 'DESCO', 'DPDC', 'Titas', 'Palli Bidyut']::text[]),
  ('Mobile & internet', 'EXPENSE', ARRAY['Mobile', 'Mobail', 'Internet', 'Net Bill', 'Recharge', 'Flexiload', 'Wifi', 'Broadband', 'GP', 'Grameenphone', 'Robi', 'Banglalink', 'Airtel', 'Teletalk']::text[]),
  ('Transport', 'EXPENSE', ARRAY['Poribohon', 'Transport', 'Jatayat', 'Rickshaw', 'Riksha', 'Uber', 'Pathao', 'Shohoz', 'CNG', 'Bus', 'Taxi', 'Train', 'Launch', 'Petrol', 'Octane', 'Bus Bhara', 'Leguna']::text[]),
  ('Health', 'EXPENSE', ARRAY['Shastho', 'Sastho', 'Health', 'Doctor', 'Daktar', 'Ousudh', 'Osudh', 'Medicine', 'Pharmacy', 'Hospital', 'Clinic', 'Diagnostic']::text[]),
  ('Education', 'EXPENSE', ARRAY['Shikkha', 'Sikkha', 'Porashona', 'Education', 'School', 'College', 'University', 'Coaching', 'Tuition', 'Private', 'Boi', 'Exam', 'Exam Fee']::text[]),
  ('Clothing', 'EXPENSE', ARRAY['Poshak', 'Clothing', 'Clothes', 'Kapor', 'Kapod', 'Jama', 'Shirt', 'Panjabi', 'Saree', 'Shari', 'Juta', 'Shoe', 'Aarong']::text[]),
  ('Family & support', 'EXPENSE', ARRAY['Poribar', 'Paribar', 'Family', 'Sohayota', 'Shohayota', 'Support', 'Ma Baba', 'Barite Taka', 'Khoraki']::text[]),
  ('Charity / zakat', 'EXPENSE', ARRAY['Dan', 'Daan', 'Zakat', 'Jakat', 'Charity', 'Donation', 'Sadaka', 'Sadaqah', 'Fitra', 'Masjid', 'Korbani']::text[]),
  ('Repairs', 'EXPENSE', ARRAY['Meramot', 'Meramat', 'Repair', 'Servicing', 'Maintenance', 'Mistri', 'Plumber', 'Electrician', 'Rong']::text[]),
  ('Entertainment', 'EXPENSE', ARRAY['Binodon', 'Binodan', 'Entertainment', 'Cinema', 'Movie', 'Netflix', 'Chorki', 'Hoichoi', 'Bongo', 'Ghora', 'Picnic', 'Concert', 'Game']::text[]),
  ('Bank charges', 'EXPENSE', ARRAY['Bank Charge', 'Bank Charj', 'Charge', 'Fee', 'Cash Out', 'Cashout', 'Send Money', 'bKash', 'Bikash', 'Nagad', 'Rocket', 'Upay', 'ATM', 'Excise Duty', 'Abgari Shulko']::text[]),
  ('Other expense', 'EXPENSE', ARRAY['Onnanno', 'Ononno', 'Bibidh', 'Kharoch', 'Other', 'Misc']::text[])
)
UPDATE "Category" c
SET "searchAliases" = s.aliases
FROM seed s
WHERE c."isSystem" = true
  AND c."searchAliases" = '{}'::text[]
  AND c."deletedAt" IS NULL
  AND c.name = s.name
  AND c.kind::text = s.kind;
