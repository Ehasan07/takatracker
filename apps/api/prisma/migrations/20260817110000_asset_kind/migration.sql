-- What kind of long-term asset an account holds, and what it cost.
--
-- Land, a car and a BO share account were all `type = 'ASSET'` and therefore
-- one undifferentiated pile: the balance sheet could not put property on its
-- own line the way IAS 1.54 asks, and the dashboard collapsed the lot to
-- "৬টি সম্পদ" because there was nothing to group by.
--
-- `purchaseCostMinor` sits alongside the ledger balance rather than replacing
-- it. The balance is the carrying amount — cost plus every revaluation since —
-- and this is the original, which is the comparison IAS 16.77(e) asks for under
-- the revaluation model.

CREATE TYPE "AssetKind" AS ENUM ('PROPERTY', 'VEHICLE', 'GOLD', 'INVESTMENT', 'OTHER');

ALTER TABLE "Account" ADD COLUMN "assetKind" "AssetKind";
ALTER TABLE "Account" ADD COLUMN "purchaseCostMinor" BIGINT;
ALTER TABLE "Account" ADD COLUMN "purchaseDate" TIMESTAMP(3);

-- Every existing ASSET account becomes OTHER rather than a guess. "Bosila LSI"
-- is land and "BO-STOCK A/C" is an investment, but inferring that from a name
-- would be the app deciding what somebody owns, and a wrong classification is
-- worse than an unclassified one — it looks answered.
UPDATE "Account" SET "assetKind" = 'OTHER' WHERE "type" = 'ASSET' AND "assetKind" IS NULL;
