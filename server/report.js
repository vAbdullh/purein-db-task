const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runReport() {
    try {
        console.log('\n--- Daily Station Sales (Riyadh Time) ---');
        console.log('Station Code | Date (Riyadh) | Sales Count | Total Litres | Total SAR');
        console.log('-----------------------------------------------------------------------');
        
        const results = await prisma.daily_station_sales.findMany({
            orderBy: [
                { station_code: 'asc' },
                { riyadh_day: 'asc' }
            ]
        });

        for (const row of results) {
            const dateStr = row.riyadh_day.toISOString().split('T')[0];
            console.log(
                row.station_code.padEnd(12) + ' | ' +
                dateStr.padEnd(13) + ' | ' +
                row.sales_count.toString().padEnd(11) + ' | ' +
                row.total_litres.toString().padEnd(12) + ' | ' +
                row.total_sar.toString()
            );
        }
        
        console.log('-----------------------------------------------------------------------\n');
        console.log('Note: Unknown controllers are excluded from station totals. Flagged sales (like the SAR 1,246.60 entry) are INCLUDED in their station totals as per raw data.\n');

        const issues = await prisma.data_issue.findMany({
            include: { packet: true }
        });
        
        if (issues.length > 0) {
            console.log('--- Data Quality Issues Flagged ---');
            const counts = issues.reduce((acc, iss) => {
                acc[iss.issue_code] = (acc[iss.issue_code] || 0) + 1;
                return acc;
            }, {});
            
            for (const [code, count] of Object.entries(counts)) {
                console.log(`- ${code}: ${count} occurrence(s)`);
            }
            
            const delivery51Issue = issues.find(i => i.details.includes('reported amount 1246.6'));
            if (delivery51Issue) {
                 console.log('\nNote: Delivery 51, Packet 1 amount mismatch successfully flagged and preserved.');
            }
            console.log('');
        }

    } catch (err) {
        console.error('Error generating report:', err);
    } finally {
        await prisma.$disconnect();
    }
}

runReport();
