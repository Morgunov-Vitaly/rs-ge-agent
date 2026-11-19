const { ACTION_RISKS, defineModule } = require('../../core/action-contract');
const { executePaymentReconciliation } = require('../../workflows/payment-reconciliation');
const { executeDeclarationReview } = require('../../workflows/declaration-review');
const { executeDeclarationDraftCreation } = require('../../workflows/declaration-draft');
const { executeDeclarationSubmission } = require('../../workflows/declaration-submit');
const { executePeriodCheck } = require('../../workflows/period-check');
const { executePaymentReconciliationSync } = require('../../workflows/payment-reconciliation-sync');

module.exports = defineModule({
    id: 'small-business',
    version: '0.7.0',
    name: 'Small Business Tax',
    capabilities: [
        'review-declaration',
        'create-declaration-draft',
        'submit-declaration',
        'reconcile-payments',
        'check-period',
        'sync-payment-reconciliation'
    ],
    actions: [
        {
            id: 'review-declaration',
            risk: ACTION_RISKS.READ_ONLY,
            handler: executeDeclarationReview
        },
        {
            id: 'create-declaration-draft',
            risk: ACTION_RISKS.DRAFT_WRITE,
            handler: executeDeclarationDraftCreation
        },
        {
            id: 'submit-declaration',
            risk: ACTION_RISKS.IRREVERSIBLE,
            handler: executeDeclarationSubmission
        },
        {
            id: 'reconcile-payments',
            risk: ACTION_RISKS.READ_ONLY,
            handler: executePaymentReconciliation
        },
        {
            id: 'check-period',
            risk: ACTION_RISKS.READ_ONLY,
            handler: executePeriodCheck
        },
        {
            id: 'sync-payment-reconciliation',
            risk: ACTION_RISKS.DATA_WRITE,
            handler: executePaymentReconciliationSync
        }
    ]
});
