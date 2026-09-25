var BSSQuote = (function () {

    // ============================================================
    // CONSTANTS: STATUS & REASONS
    // ============================================================

    var STATUS = {
        DRAFT: 760820000,
        ACTIVE: 760820001,
        WON: 760820002,
        CLOSED: 760820003
    };

    var STATUS_REASON = {
        IN_PROGRESS: 1,
        OPEN: 2,
        WON: 3,
        LOST: 4,
        CANCELED: 5,
        REVISED: 6
    };

    var CUSTOMER_RESPONSE = {
        REJECTED: 1,
        APPROVED: 2
    };

    var FIELDS = {
        STATUS: "bss_status",
        STATUS_REASON: "bss_statusreason",
        CUSTOMER_RESPONSE: "bss_customerresponses"
    };

    // ============================================================
    // 1. FILTER STATUS REASON OPTIONS
    // ============================================================

    function filterStatusReason(executionContext) {
        try {
            var formContext = executionContext.getFormContext();
            var status = formContext.getAttribute(FIELDS.STATUS);
            var reason = formContext.getAttribute(FIELDS.STATUS_REASON);
            var control = formContext.getControl(FIELDS.STATUS_REASON);

            if (!status || !reason || !control) return;

            var statusValue = status.getValue();
            var currentReason = reason.getValue();

            control.clearOptions();

            if (statusValue === STATUS.DRAFT) {
                control.addOption({ text: "In Progress", value: STATUS_REASON.IN_PROGRESS });
            } else if (statusValue === STATUS.ACTIVE) {
                control.addOption({ text: "In Progress", value: STATUS_REASON.IN_PROGRESS });
                control.addOption({ text: "Open", value: STATUS_REASON.OPEN });
            } else if (statusValue === STATUS.WON) {
                control.addOption({ text: "Won", value: STATUS_REASON.WON });
            } else if (statusValue === STATUS.CLOSED) {
                control.addOption({ text: "Lost", value: STATUS_REASON.LOST });
                control.addOption({ text: "Canceled", value: STATUS_REASON.CANCELED });
                control.addOption({ text: "Revised", value: STATUS_REASON.REVISED });
            }

            if (statusValue === STATUS.DRAFT || statusValue === STATUS.ACTIVE) {
                reason.setValue(STATUS_REASON.IN_PROGRESS);
            } else if (statusValue === STATUS.WON) {
                reason.setValue(STATUS_REASON.WON);
            } else if (statusValue === STATUS.CLOSED) {
                reason.setValue(STATUS_REASON.LOST);
            }
        } catch (error) {
            console.error("BSSQuote.filterStatusReason:", error);
        }
    }

    // ============================================================
    // 2. CUSTOMER RESPONSE CHANGE
    // ============================================================

    function customerResponseChange(executionContext) {
        try {
            var formContext = executionContext.getFormContext();
            var response = formContext.getAttribute(FIELDS.CUSTOMER_RESPONSE);
            var status = formContext.getAttribute(FIELDS.STATUS);
            var reason = formContext.getAttribute(FIELDS.STATUS_REASON);

            if (!response || !status || !reason) return;

            var responseValue = response.getValue();

            if (responseValue === CUSTOMER_RESPONSE.APPROVED) {
                status.setValue(STATUS.ACTIVE);
                reason.setValue(STATUS_REASON.IN_PROGRESS);
                status.fireOnChange();
            } else if (responseValue === CUSTOMER_RESPONSE.REJECTED) {
                status.setValue(STATUS.CLOSED);
                reason.setValue(STATUS_REASON.LOST);
                status.fireOnChange();

                Xrm.Navigation.openAlertDialog({
                    title: "Quote Rejected",
                    text: "The Quote has been marked as Closed with Lost status reason."
                });
            }
        } catch (error) {
            console.error("BSSQuote.customerResponseChange:", error);
        }
    }

    // ============================================================
    // 3. ACTIVATE QUOTE
    // ============================================================

    function activateQuote(primaryControl) {
        try {
            var formContext = primaryControl;
            var status = formContext.getAttribute(FIELDS.STATUS);
            var reason = formContext.getAttribute(FIELDS.STATUS_REASON);

            if (!status || !reason || status.getValue() !== STATUS.DRAFT) return;

            Xrm.Navigation.openConfirmDialog({
                title: "Activate Quote",
                text: "Are you sure you want to activate this Quote?",
                confirmButtonLabel: "Activate",
                cancelButtonLabel: "Cancel"
            }).then(function (result) {
                if (!result.confirmed) return;

                status.setValue(STATUS.ACTIVE);
                reason.setValue(STATUS_REASON.IN_PROGRESS);

                formContext.data.save().then(function () {
                    formContext.data.refresh(false);
                });
            });
        } catch (error) {
            console.error("BSSQuote.activateQuote:", error);
        }
    }

    // ============================================================
    // 4. READ-ONLY CONTROL
    // ============================================================

    function setFormReadOnly(executionContext) {
        try {
            var formContext = executionContext.getFormContext();
            var status = formContext.getAttribute(FIELDS.STATUS);

            if (!status) return;

            var value = status.getValue();
            if (value === STATUS.ACTIVE || value === STATUS.WON || value === STATUS.CLOSED) {
                formContext.ui.controls.forEach(function (control) {
                    if (control && typeof control.setDisabled === "function") {
                        control.setDisabled(true);
                    }
                });
            }
        } catch (error) {
            console.error("BSSQuote.setFormReadOnly:", error);
        }
    }

    // ============================================================
    // 5. RIBBON ENABLE RULES
    // ============================================================

    function canActivateQuote(primaryControl) {
        var status = primaryControl.getAttribute(FIELDS.STATUS);
        return status && status.getValue() === STATUS.DRAFT;
    }

    function canCreateOrder(primaryControl) {
        var response = primaryControl.getAttribute(FIELDS.CUSTOMER_RESPONSE);
        return response && response.getValue() === CUSTOMER_RESPONSE.APPROVED;
    }

    // ============================================================
    // 6. CREATE ORDER & COPY TO ORDER PRODUCTS
    // ============================================================

    async function createOrder(primaryControl) {
        var progressShown = false;

        try {
            var quoteFormContext = primaryControl;

            var responseAttr = quoteFormContext.getAttribute(FIELDS.CUSTOMER_RESPONSE);
            var statusAttr = quoteFormContext.getAttribute(FIELDS.STATUS);
            var reasonAttr = quoteFormContext.getAttribute(FIELDS.STATUS_REASON);

            if (!responseAttr || responseAttr.getValue() !== CUSTOMER_RESPONSE.APPROVED) {
                await Xrm.Navigation.openAlertDialog({
                    title: "Create Order",
                    text: "Customer Response must be Approved."
                });
                return;
            }

            if (quoteFormContext.data.entity.getIsDirty()) {
                await quoteFormContext.data.save();
            }

            var confirm = await Xrm.Navigation.openConfirmDialog({
                title: "Create Order",
                text: "A new Order will be created with all Quote Products. Continue?",
                confirmButtonLabel: "Create Order",
                cancelButtonLabel: "Cancel"
            });

            if (!confirm.confirmed) return;

            Xrm.Utility.showProgressIndicator("Creating Order & saving products...");
            progressShown = true;

            function getVal(attrName) {
                var attr = quoteFormContext.getAttribute(attrName);
                return attr ? attr.getValue() : null;
            }

            var currentQuoteId = quoteFormContext.data.entity.getId().replace(/[{}]/g, "");
            var qName = getVal("bss_quotename");

            // 1. Order Header Payload
            var orderPayload = {
                "bss_name": qName ? qName : "Order - Quote"
            };

            if (getVal("bss_description")) orderPayload["bss_description"] = getVal("bss_description");
            if (getVal("bss_totallineitemamount") !== null) orderPayload["bss_totallineitemamount"] = Number(getVal("bss_totallineitemamount"));
            if (getVal("bss_totalamount") !== null) orderPayload["bss_totalamount"] = Number(getVal("bss_totalamount"));

            var createdOrder = await Xrm.WebApi.createRecord("bss_order", orderPayload);
            var orderId = createdOrder.id.replace(/[{}]/g, "");

            // 2. Fetch Quote Products using verified `_bss_quote_value`
            var fetchQuery = "?$filter=_bss_quote_value eq " + currentQuoteId;
            var quoteProducts = await Xrm.WebApi.retrieveMultipleRecords("bss_quoteproduct", fetchQuery);

            // 3. Insert into `bss_orderproduct` with Schema Names
            if (quoteProducts && quoteProducts.entities && quoteProducts.entities.length > 0) {
                for (var i = 0; i < quoteProducts.entities.length; i++) {
                    var qp = quoteProducts.entities[i];

                    var linePayload = {
                        "bss_quantity": qp.bss_quantity !== undefined && qp.bss_quantity !== null ? Number(qp.bss_quantity) : 1,
                        "bss_priceperunit": qp.bss_priceperunit !== undefined && qp.bss_priceperunit !== null ? Number(qp.bss_priceperunit) : 0,
                        "bss_order@odata.bind": "/bss_orders(" + orderId + ")"
                    };

                    if (qp.bss_extendedamount !== null && qp.bss_extendedamount !== undefined) {
                        linePayload["bss_extendedamount"] = Number(qp.bss_extendedamount);
                    }
                    if (qp.bss_tax !== null && qp.bss_tax !== undefined) {
                        linePayload["bss_tax"] = Number(qp.bss_tax);
                    }
                    
                    // Corrected: bss_manualdiscount instead of bss_manualdiscountamount
                    if (qp.bss_manualdiscount !== null && qp.bss_manualdiscount !== undefined) {
                        linePayload["bss_manualdiscount"] = Number(qp.bss_manualdiscount);
                    }

                    // Product Lookup: bss_productname@odata.bind
                    var prodId = qp._bss_productname_value;
                    if (prodId) {
                        linePayload["bss_productname@odata.bind"] = "/bss_products(" + prodId.replace(/[{}]/g, "") + ")";
                    }

                    // Unit Lookup: bss_unit@odata.bind
                    var unitId = qp._bss_unit_value;
                    if (unitId) {
                        linePayload["bss_unit@odata.bind"] = "/bss_units(" + unitId.replace(/[{}]/g, "") + ")";
                    }

                    await Xrm.WebApi.createRecord("bss_orderproduct", linePayload);
                }
            }

            // 4. Mark Quote as WON
            statusAttr.setValue(STATUS.WON);
            reasonAttr.setValue(STATUS_REASON.WON);
            await quoteFormContext.data.save();

            // 5. Header Form Parameters for UI
            var formParameters = {};

            if (getVal("bss_shippingmethodcode") !== null) formParameters["bss_shippingmethodcode"] = getVal("bss_shippingmethodcode");
            if (getVal("bss_paymenttermscode") !== null) formParameters["bss_paymenttermscode"] = getVal("bss_paymenttermscode");
            if (getVal("bss_freighttermscode") !== null) formParameters["bss_freighttermscode"] = getVal("bss_freighttermscode");

            if (getVal("bss_totallineitemamount") !== null) formParameters["bss_totallineitemamount"] = getVal("bss_totallineitemamount");
            if (getVal("bss_quotediscount") !== null) formParameters["bss_discountpercentage"] = getVal("bss_quotediscount");
            if (getVal("bss_totaltax") !== null) formParameters["bss_totaltax"] = getVal("bss_totaltax");
            if (getVal("bss_totalamount") !== null) formParameters["bss_totalamount"] = getVal("bss_totalamount");
            if (getVal("bss_quotediscountamount") !== null) formParameters["bss_discountamount"] = getVal("bss_quotediscountamount");
            if (getVal("bss_totalamountlessfreight") !== null) formParameters["bss_totalamountlessfreight"] = getVal("bss_totalamountlessfreight");
            if (getVal("bss_freightamount") !== null) formParameters["bss_freightamount"] = getVal("bss_freightamount");

            if (getVal("bss_billtostreet1")) formParameters["bss_billto_line1"] = getVal("bss_billtostreet1");
            if (getVal("bss_billtostreet2")) formParameters["bss_billto_line2"] = getVal("bss_billtostreet2");
            if (getVal("bss_billtostreet3")) formParameters["bss_billto_line3"] = getVal("bss_billtostreet3");
            if (getVal("bss_billtocity")) formParameters["bss_billto_city"] = getVal("bss_billtocity");
            if (getVal("bss_billtostate")) formParameters["bss_billto_stateorprovince"] = getVal("bss_billtostate");
            if (getVal("bss_zippostelcode")) formParameters["bss_billto_postalcode"] = getVal("bss_zippostelcode");
            if (getVal("bss_billtocountry")) formParameters["bss_billto_country"] = getVal("bss_billtocountry");

            if (getVal("bss_willcall") !== null) formParameters["bss_willcall"] = getVal("bss_willcall");
            if (getVal("bss_shiptostreet1")) formParameters["bss_shipto_line1"] = getVal("bss_shiptostreet1");
            if (getVal("bss_shiptostreet2")) formParameters["bss_shipto_line2"] = getVal("bss_shiptostreet2");
            if (getVal("bss_shiptostreet3")) formParameters["bss_shipto_line3"] = getVal("bss_shiptostreet3");
            if (getVal("bss_shiptocity")) formParameters["bss_shipto_city"] = getVal("bss_shiptocity");
            if (getVal("bss_shiptostate")) formParameters["bss_shipto_stateorprovince"] = getVal("bss_shiptostate");
            if (getVal("bss_shiptozippostelcode")) formParameters["bss_shipto_postalcode"] = getVal("bss_shiptozippostelcode");
            if (getVal("bss_shiptocountry")) formParameters["bss_shipto_country"] = getVal("bss_shiptocountry");

            var priceList = getVal("bss_pricelevelid");
            if (priceList && priceList.length > 0) {
                formParameters["bss_pricelevelid"] = "{" + priceList[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_pricelevelidname"] = priceList[0].name;
                formParameters["bss_pricelevelidtype"] = priceList[0].entityType || "bss_pricelist";
            }

            var opp = getVal("bss_opportunity");
            if (opp && opp.length > 0) {
                formParameters["bss_opportunityid"] = "{" + opp[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_opportunityidname"] = opp[0].name;
                formParameters["bss_opportunityidtype"] = opp[0].entityType || "bss_opportunity";
            }

            var customer = getVal("bss_potentialcustomerid");
            if (customer && customer.length > 0) {
                formParameters["bss_potentialcustomer"] = "{" + customer[0].id.replace(/[{}]/g, "") + "}";
                formParameters["bss_potentialcustomername"] = customer[0].name;
                formParameters["bss_potentialcustomertype"] = customer[0].entityType || "account";
            }

            formParameters["bss_quoteid"] = "{" + currentQuoteId + "}";
            formParameters["bss_quoteidname"] = qName || "Quote";
            formParameters["bss_quoteidtype"] = "bss_quote";

            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
                progressShown = false;
            }

            // 6. Open Order with Populated Subgrid
            await Xrm.Navigation.openForm({
                entityName: "bss_order",
                entityId: orderId,
                useQuickCreateForm: false
            }, formParameters);

        } catch (error) {
            if (progressShown) {
                Xrm.Utility.closeProgressIndicator();
            }
            console.error("CREATE ORDER ERROR:", error);
            await Xrm.Navigation.openErrorDialog({
                title: "Create Order Failed",
                message: error.message || "Failed to complete operation."
            });
        }
    }

    return {
        filterStatusReason: filterStatusReason,
        customerResponseChange: customerResponseChange,
        activateQuote: activateQuote,
        setFormReadOnly: setFormReadOnly,
        canActivateQuote: canActivateQuote,
        canCreateOrder: canCreateOrder,
        createOrder: createOrder
    };

})();