# Journeys for envdiff

One journey per heading; one step per line, numbered or bulleted or neither.
Run them with `envdiff prod uat --journey-file journeys.md` (or the Action's
`journey-file` input). The baseline goes first; the candidate then does the same
thing to the same control, and every step is compared.

## Filter orders
1. Go to Orders
2. Type "west" into Search orders
3. Sort by Amount descending
4. Make sure the Orders grid has rows
5. Take a screenshot "West orders"

## Monthly sales report
- Open Reports
- Select "Last 30 days" from Date range
- Click Apply
- Expect to see "Sales by region"
- Hover over the Sales by region chart
- Check that the Sales by region chart shows Online

## Export
- Go to Orders
- Click Export CSV
- Expect no errors
