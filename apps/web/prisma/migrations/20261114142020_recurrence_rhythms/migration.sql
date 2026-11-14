-- Rhythms beyond « every week » (PAT-05): a recurrence may come back every N weeks (counted from the week of
-- its start date), occur on explicit dates only (chemotherapy cycles), and give some weekdays their own time
-- or session length. Existing recurrences keep their weekly rhythm (interval 1, no date, no own time).

-- AlterTable
ALTER TABLE "Recurrence" ADD COLUMN     "daySchedules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "intervalWeeks" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sessionDates" DATE[] DEFAULT ARRAY[]::DATE[];
