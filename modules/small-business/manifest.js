const { ACTION_RISKS, defineModule } = require('../../core/action-contract');
const { executePaymentReconciliation } = require('../../workflows/payment-reconciliation');
const { executeDeclarationReview } = require('../../workflows/declaration-review');
const { executeDeclarationDraftCreation } = require('../../workflows/declaration-draft');

module.exports = defineModule({
    id: 'small-business',
    version: '0.2.0',
    name: 'Small Business Tax',
    capabilities: ['review-declaration', 'create-declaration-draft', 'reconcile-payments'],
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
            id: 'reconcile-payments',
            risk: ACTION_RISKS.READ_ONLY,
            handler: executePaymentReconciliation
        }
    ]
});
