var BSS = BSS || {};

BSS.Order = (function () {

    var STATUS = {
        ACTIVE: 0,
        SUBMITTED: 1,
        CANCELED: 2,
        FULFILLED: 3,
        INVOICED: 4
    };

    var STATUS_REASON = {
        NEW: 1,
        PENDING: 2,
        IN_PROGRESS: 3,
        NO_MONEY: 4,
        COMPLETE: 100001,
        PARTIAL: 100002,
        INVOICED: 100003
    };

    // ============================================================
    // 1. RIBBON ENABLE RULE
    // ============================================================
    function canCreateInvoice(primaryControl) {
        try {
            var formContext = primaryControl;
            if (!formContext) return false;

            var status = formContext.getAttribute("bss_status");
            if (status && status.getValue() !== STATUS.ACTIVE) return false;

            var inv = formContext.getAttribute("bss_invoice");
            if (inv && inv.getValue() && inv.getValue().length > 0) return false;

            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // 2. MAIN ACTION: CREATE INVOICE & COPY TO INVOICE PRODUCTS
    // ============================================================
    async function createInvoice(primaryControl) {
        var progressShown = false;

        try {
            var formContext = primaryControl;
            if (!formContext) throw new Error("Form context is not available.");

            var rawOrderId = formContext.data.entity.getId();
            if (!rawOrderId) {
                await Xrm.Navigation.openAlertDialog({
                    title: "Create Invoice",
                    text: "Please save the Order before creating an Invoice."
                });
                return;
            }
            var orderId = rawOrderId.replace(/[{}]/g, "").toLowerCase();

            var statusAttribute = formContext.getAttribute("bss_status");
            if (statusAttribute && statusAttribute.getValue() !== STATUS.ACTIVE) {
                await Xrm.Navigation.openAlertDialog({
                    title: "Create Invoice",
                    text: "Order is not Active."
                });
                return;
            }

            var invoiceAttribute = formContext.getAttribute("bss_invoice");
            if (invoiceAttribute && invoiceAttribute.getValue() && invoiceAttribute.getValue().length > 0) {
                await Xrm.Navigation.openAlertDialog({
                    title: "Create Invoice",
                    text: "An Invoice is already associated with this Order."
                });
                return;
            }

            if (formContext.data.entity.getIsDirty()) {
                await formContext.data.save();
            }

            var confirmation = await Xrm.Navigation.openConfirmDialog({
                title: "Create Invoice",
                text: "A new Invoice will be created with all Order Products. Continue?",
                confirmButtonLabel: "Create Invoice",
                cancelButtonLabel: "Cancel"
            });

            if (!confirmation.confirmed) return;

            Xrm.Utility.showProgressIndicator("Creating Invoice & saving products...");
            progressShown = true;

            function getVal(attrName) {
                var attr = formContext.getAttribute(attrName);
                return attr ? attr.getValue() : null;
            }

            var orderName = getVal("bss_name");

            // 1. Invoice Header Payload
            var invoicePayload = {
                "bss_invoicename": orderName ? "Invoice - " + orderName : "Invoice - Order",
                "bss_order@odata.bind": "/bss_orders(" + orderId + ")"
            };

            if (getVal("bss_description")) invoicePayload["bss_description"] = getVal("bss_description");
            if (getVal("bss_totallineitemamount") !== null) invoicePayload["bss_totallineitemamount"] = Number(getVal("bss_totallineitemamount"));
            if (getVal("bss_totalamount") !== null) invoicePayload["bss_totalamount"] = Number(getVal("bss_totalamount"));

            var createdInvoice = await Xrm.WebApi.createRecord("bss_invoice", invoicePayload);
            var invoiceId = createdInvoice.id.replace(/[{}]/g, "");

            // 2. Fetch Order Products using verified `_bss_order_value`
            var fetchQuery = "?$filter=_bss_order_value eq " + orderId;
            var orderProducts = await Xrm.WebApi.retrieveMultipleRecords("bss_orderproduct", fetchQuery);

            // 3. Insert into `bss_invoiceproduct` with Price Per Unit (`bss_priceperunit`)
            if (orderProducts && orderProducts.entities && orderProducts.entities.length > 0) {
                for (var i = 0; i < orderProducts.entities.length; i++) {
                    var op = orderProducts.entities[i];

                    var prodName = op["_bss_productname_value@OData.Community.Display.V1.FormattedValue"] || op.bss_name || "Invoice Product";
                    var unitPriceVal = op.bss_priceperunit !== undefined && op.bss_priceperunit !== null ? Number(op.bss_priceperunit) : 0;

                    var linePayload = {
                        "bss_name": prodName,
                        "bss_quantity": op.bss_quantity !== undefined && op.bss_quantity !== null ? Number(op.bss_quantity) : 1,
                        "bss_quality": op.bss_quantity !== undefined && op.bss_quantity !== null ? Number(op.bss_quantity) : 1,
                        "bss_unitsprice": unitPriceVal,
                        "bss_priceperunit": unitPriceVal,
                        "bss_invoice@odata.bind": "/bss_invoices(" + invoiceId + ")"
                    };

                    if (op.bss_extendedamount !== null && op.bss_extendedamount !== undefined) {
                        linePayload["bss_extendedamount"] = Number(op.bss_extendedamount);
                        linePayload["bss_netamount"] = Number(op.bss_extendedamount);
                        linePayload["bss_totalamount"] = Number(op.bss_extendedamount);
                    }
                    if (op.bss_tax !== null && op.bss_tax !== undefined) {
                        linePayload["bss_tax"] = Number(op.bss_tax);
                    }
                    if (op.bss_manualdiscount !== null && op.bss_manualdiscount !== undefined) {
                        linePayload["bss_manualdiscount"] = Number(op.bss_manualdiscount);
                        linePayload["bss_discount"] = Number(op.bss_manualdiscount);
                    }

                    // Unit Lookup binding safely
                    var unitId = op._bss_unit_value;
                    if (unitId) {
                        linePayload["bss_unit@odata.bind"] = "/bss_units(" + unitId.replace(/[{}]/g, "") + ")";
                    }

                    await Xrm.WebApi.createRecord("bss_invoiceproduct", linePayload);
                }
            }

            // 4. Update Order Status to Invoiced
            statusAttribute.setValue(STATUS.INVOICED);
            var reasonAttr = formContext.getAttribute("bss_statusreason");
            if (reasonAttr) reasonAttr.setValue(STATUS_REASON.INVOICED);
            await formContext.data.save();

            // 5. Header Form Parameters for UI (Addresses, terms, lookups)
            var formParameters = {};

            if (getVal("bss_shippingmethodcode") !== null) formParameters["bss_shippingmethodcode"] = getVal("bss_shippingmethodcode");
            if (getVal("bss_paymenttermscode") !== null) formParameters["bss_paymenttermscode"] = getVal("bss_paymenttermscode");
            if (getVal("bss_freighttermscode") !== null) formParameters["bss_freighttermscode"] = getVal("bss_freighttermscode");

            if (getVal("bss_totallineitemamount") !== null) formParameters["bss_totallineitemamount"] = getVal("bss_totallineitemamount");
            if (getVal("bss_discountpercentage") !== null) formParameters["bss_discountpercentage"] = getVal("bss_discountpercentage");
            if (getVal("bss_totaltax") !== null) formParameters["bss_totaltaxamount"] = getVal("bss_totaltax");
            if (getVal("bss_totalamount") !== null) formParameters["bss_totalamount"] = getVal("bss_totalamount");
            if (getVal("bss_discountamount") !== null) formParameters["bss_discountamount"] = getVal("bss_discountamount");
            if (getVal("bss_totalamountlessfreight") !== null) formParameters["bss_totalamountlessfreight"] = getVal("bss_totalamountlessfreight");
            if (getVal("bss_freightamount") !== null) formParameters["bss_freightamount"] = getVal("bss_freightamount");

            // Addresses
            if (getVal("bss_billto_line1")) formParameters["bss_billtostreet1"] = getVal("bss_billto_line1");
            if (getVal("bss_billto_line2")) formParameters["bss_billtostreet2"] = getVal("bss_billto_line2");
            if (getVal("bss_billto_line3")) formParameters["bss_billtostreet3"] = getVal("bss_billto_line3");
            if (getVal("bss_billto_city")) formParameters["bss_billtocity"] = getVal("bss_billto_city");
            if (getVal("bss_billto_stateorprovince")) formParameters["bss_billtostate"] = getVal("bss_billto_stateorprovince");
            if (getVal("bss_billto_postalcode")) formParameters["bss_billtozippostelcode"] = getVal("bss_billto_postalcode");
            if (getVal("bss_billto_country")) formParameters["bss_billtocountry"] = getVal("bss_billto_country");

            if (getVal("bss_willcall") !== null) formParameters["bss_willcall"] = getVal("bss_willcall");
            if (getVal("bss_shipto_line1")) formParameters["bss_shiptostreet1"] = getVal("bss_shipto_line1");
            if (getVal("bss_shipto_line2")) formParameters["bss_shiptostreet2"] = getVal("bss_shipto_line2");
            if (getVal("bss_shipto_line3")) formParameters["bss_shiptostreet3"] = getVal("bss_shipto_line3");
            if (getVal("bss_shipto_city")) formParameters["bss_shiptocity"] = getVal("bss_shipto_city");
            if (getVal("bss_shipto_stateorprovince")) formParameters["bss_shiptostate"] = getVal("bss_shipto_stateorprovince");
            if (getVal("bss_shipto_postalcode")) formParameters["bss_shiptozippostalcode"] = getVal("bss_shipto_postalcode");
            if (getVal("bss_shipto_country")) formParameters["bss_shiptocountry"] = getVal("bss_shipto_country");

            var priceList = getVal("bss_pricelevelid");
            if (priceList && priceList.length > 0) {
                formParameters["bss_pricelevelid"] = "{" + priceList[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_pricelevelidname"] = priceList[0].name;
                formParameters["bss_pricelevelidtype"] = priceList[0].entityType || "bss_pricelist";
            }

            var opp = getVal("bss_opportunityid");
            if (opp && opp.length > 0) {
                formParameters["bss_opportunity"] = "{" + opp[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_opportunityname"] = opp[0].name;
                formParameters["bss_opportunitytype"] = opp[0].entityType || "bss_opportunity";
            }

            var customer = getVal("bss_potentialcustomer");
            if (customer && customer.length > 0) {
                formParameters["bss_customerid"] = "{" + customer[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_customeridname"] = customer[0].name;
                formParameters["bss_customeridtype"] = customer[0].entityType || "account";
            }

            formParameters["bss_order"] = "{" + orderId + "}";
            formParameters["bss_ordername"] = orderName || "Order";
            formParameters["bss_ordertype"] = "bss_order";

            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
                progressShown = false;
            }

            // 6. Open Invoice Form
            await Xrm.Navigation.openForm({
                entityName: "bss_invoice",
                entityId: invoiceId,
                useQuickCreateForm: false
            }, formParameters);

        } catch (error) {
            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
            }
            console.error("CREATE INVOICE ERROR:", error);
            await Xrm.Navigation.openErrorDialog({
                title: "Create Invoice Failed",
                message: error.message || "Failed to complete operation."
            });
        }
    }

    return {
        canCreateInvoice: canCreateInvoice,
        createInvoice: createInvoice
    };

})();

var BSSOrder = BSS.Order;